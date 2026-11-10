from __future__ import annotations

import json
from collections.abc import AsyncIterator
from urllib.parse import urlsplit

import httpx

from .models import AIProviderConfig, DiscoveredModel


class ProviderRequestError(RuntimeError):
    pass


def _provider_headers(provider: AIProviderConfig) -> dict[str, str]:
    headers = dict(provider.headers)
    if provider.apiKey:
        headers.setdefault("Authorization", f"Bearer {provider.apiKey}")
    return headers


def _provider_url(provider: AIProviderConfig, path: str) -> str:
    return f"{provider.baseUrl.rstrip('/')}/{path.lstrip('/')}"


async def list_models(provider: AIProviderConfig) -> list[DiscoveredModel]:
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(_provider_url(provider, "models"), headers=_provider_headers(provider))

    if response.status_code >= 400:
        raise ProviderRequestError(f"Model listing failed: HTTP {response.status_code} {response.text[:500]}")

    payload = response.json()
    raw_models = payload.get("data", payload if isinstance(payload, list) else [])
    models: list[DiscoveredModel] = []

    for item in raw_models:
        if isinstance(item, str):
            models.append(DiscoveredModel(id=item))
        elif isinstance(item, dict) and item.get("id"):
            models.append(DiscoveredModel(id=item["id"], ownedBy=item.get("owned_by") or item.get("ownedBy")))

    return models


async def test_chat_completion(provider: AIProviderConfig, model_id: str) -> None:
    payload = {
        "model": model_id,
        "messages": [{"role": "user", "content": "Reply with OK."}],
        "max_tokens": 8,
        "stream": False,
    }

    async with httpx.AsyncClient(timeout=45.0) as client:
        response = await client.post(
            _provider_url(provider, "chat/completions"),
            headers=_provider_headers(provider),
            json=payload,
        )

    if response.status_code >= 400:
        raise ProviderRequestError(f"Chat completion failed: HTTP {response.status_code} {response.text[:500]}")


async def create_chat_completion(
    provider: AIProviderConfig,
    model_id: str,
    messages: list[dict[str, str]],
    max_tokens: int = 2000,
    json_response: bool = True,
) -> str:
    host = (urlsplit(provider.baseUrl).hostname or "").lower()
    normalized_model = model_id.lower().removeprefix("pro/")
    is_siliconflow_kimi = (
        host in {"api.siliconflow.cn", "api.siliconflow.com"}
        and normalized_model.startswith("moonshotai/kimi-k2.7")
    )
    if is_siliconflow_kimi:
        try:
            chunks = [
                chunk
                async for chunk in stream_chat_completion(
                    provider,
                    model_id,
                    messages,
                    max_tokens=max_tokens,
                    json_response=json_response,
                    temperature=0.4,
                    read_timeout=120.0,
                    require_complete=True,
                )
            ]
        except httpx.TimeoutException as exc:
            raise ProviderRequestError("Chat completion timed out while waiting for provider activity.") from exc
        content = "".join(chunks)
        if not content.strip():
            raise ProviderRequestError("Chat completion failed: provider returned no final content.")
        return content

    payload = {
        "model": model_id,
        "messages": messages,
        "max_tokens": max_tokens,
        "stream": False,
        "temperature": 0.4,
    }
    if json_response:
        payload["response_format"] = {"type": "json_object"}

    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(
            _provider_url(provider, "chat/completions"),
            headers=_provider_headers(provider),
            json=payload,
        )

    if response.status_code >= 400:
        raise ProviderRequestError(f"Chat completion failed: HTTP {response.status_code} {response.text[:500]}")

    payload = response.json()
    choices = payload.get("choices")
    if not choices or not isinstance(choices, list):
        raise ProviderRequestError("Chat completion failed: response did not contain choices.")

    message = choices[0].get("message") if isinstance(choices[0], dict) else None
    content = message.get("content") if isinstance(message, dict) else None
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        text_parts = [
            part.get("text")
            for part in content
            if isinstance(part, dict) and isinstance(part.get("text"), str)
        ]
        return "\n".join(text_parts)

    raise ProviderRequestError("Chat completion failed: response message content was empty.")


async def stream_chat_completion(
    provider: AIProviderConfig,
    model_id: str,
    messages: list[dict[str, str]],
    max_tokens: int = 2000,
    json_response: bool = False,
    temperature: float = 0.7,
    read_timeout: float | None = None,
    require_complete: bool = False,
) -> AsyncIterator[str]:
    payload = {
        "model": model_id,
        "messages": messages,
        "max_tokens": max_tokens,
        "stream": True,
        "temperature": temperature,
    }
    if json_response:
        payload["response_format"] = {"type": "json_object"}

    timeout = httpx.Timeout(read_timeout, connect=30.0) if read_timeout is not None else None
    completed = False
    async with httpx.AsyncClient(timeout=timeout) as client:
        async with client.stream(
            "POST",
            _provider_url(provider, "chat/completions"),
            headers=_provider_headers(provider),
            json=payload,
        ) as response:
            if response.status_code >= 400:
                text = await response.aread()
                raise ProviderRequestError(
                    f"Chat completion failed: HTTP {response.status_code} {text.decode('utf-8', errors='replace')[:500]}"
                )

            async for line in response.aiter_lines():
                if not line.startswith("data:"):
                    continue

                data = line.removeprefix("data:").strip()
                if data == "[DONE]":
                    completed = True
                    break
                if not data:
                    continue

                try:
                    payload = json.loads(data)
                except json.JSONDecodeError:
                    continue

                if isinstance(payload, dict) and payload.get("error"):
                    raise ProviderRequestError("Chat completion failed: provider returned a stream error.")

                choices = payload.get("choices")
                if not isinstance(choices, list) or not choices:
                    continue

                choice = choices[0]
                if not isinstance(choice, dict):
                    continue

                finish_reason = choice.get("finish_reason")
                if require_complete and finish_reason == "length":
                    raise ProviderRequestError("Chat completion failed: provider truncated the response.")
                if finish_reason == "stop":
                    completed = True

                delta = choice.get("delta")
                if isinstance(delta, dict):
                    content = delta.get("content")
                    if isinstance(content, str):
                        yield content
                    continue

                message = choice.get("message")
                if isinstance(message, dict):
                    content = message.get("content")
                    if isinstance(content, str):
                        yield content

    if require_complete and not completed:
        raise ProviderRequestError("Chat completion failed: provider stream ended before completion.")


async def test_embedding(provider: AIProviderConfig, model_id: str) -> int | None:
    payload = {
        "model": model_id,
        "input": "Novel Canvas embedding test.",
    }

    async with httpx.AsyncClient(timeout=45.0) as client:
        response = await client.post(
            _provider_url(provider, "embeddings"),
            headers=_provider_headers(provider),
            json=payload,
        )

    if response.status_code >= 400:
        raise ProviderRequestError(f"Embedding failed: HTTP {response.status_code} {response.text[:500]}")

    payload = response.json()
    data = payload.get("data")
    if not data or not isinstance(data, list):
        return None

    embedding = data[0].get("embedding") if isinstance(data[0], dict) else None
    return len(embedding) if isinstance(embedding, list) else None


async def create_embeddings(provider: AIProviderConfig, model_id: str, texts: list[str]) -> list[list[float]]:
    if not texts:
        return []

    payload = {
        "model": model_id,
        "input": texts,
    }

    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(
            _provider_url(provider, "embeddings"),
            headers=_provider_headers(provider),
            json=payload,
        )

    if response.status_code >= 400:
        raise ProviderRequestError(f"Embedding failed: HTTP {response.status_code} {response.text[:500]}")

    payload = response.json()
    data = payload.get("data")
    if not isinstance(data, list):
        raise ProviderRequestError("Embedding failed: response did not contain a data array.")

    ordered = sorted(
        [item for item in data if isinstance(item, dict) and isinstance(item.get("embedding"), list)],
        key=lambda item: item.get("index", 0),
    )
    embeddings = [[float(value) for value in item["embedding"]] for item in ordered]

    if len(embeddings) != len(texts):
        raise ProviderRequestError(
            f"Embedding failed: expected {len(texts)} vector(s), received {len(embeddings)}."
        )

    return embeddings
