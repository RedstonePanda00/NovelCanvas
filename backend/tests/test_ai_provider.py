from backend.tests import environment as _test_environment

import asyncio
import json
import unittest
from unittest.mock import patch

import httpx

from backend.app.ai_provider import ProviderRequestError, create_chat_completion
from backend.app.models import AIProviderConfig


class ReasoningStreamTests(unittest.TestCase):
    def setUp(self):
        self.provider = AIProviderConfig(
            id="siliconflow",
            name="SiliconFlow",
            baseUrl="https://api.siliconflow.cn/v1",
            apiKey="test-key",
        )
        self.original_client = httpx.AsyncClient

    def complete(self, handler, model_id="moonshotai/Kimi-K2.7-Code"):
        transport = httpx.MockTransport(handler)

        def client_factory(**kwargs):
            return self.original_client(transport=transport, **kwargs)

        with patch("backend.app.ai_provider.httpx.AsyncClient", side_effect=client_factory):
            return asyncio.run(create_chat_completion(
                self.provider, model_id, [{"role": "user", "content": "Test"}],
                max_tokens=700, json_response=False,
            ))

    def test_reasoning_is_consumed_without_returning_it(self):
        def handler(request):
            payload = json.loads(request.content)
            self.assertTrue(payload["stream"])
            self.assertEqual(payload["temperature"], 0.4)
            self.assertNotIn("thinking_budget", payload)
            return httpx.Response(200, text=(
                'data: {"choices":[{"delta":{"reasoning_content":"private reasoning"}}]}\n\n'
                'data: {"choices":[{"delta":{"content":"final "}}]}\n\n'
                'data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}\n\n'
                'data: [DONE]\n\n'
            ))

        self.assertEqual(self.complete(handler), "final answer")

    def test_rejects_truncated_or_missing_final_content(self):
        for stream in (
            'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}\n\n',
            'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\ndata: [DONE]\n\n',
            'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
        ):
            with self.subTest(stream=stream), self.assertRaises(ProviderRequestError):
                self.complete(lambda request: httpx.Response(200, text=stream))

    def test_other_models_keep_non_streaming_requests(self):
        def handler(request):
            self.assertFalse(json.loads(request.content)["stream"])
            return httpx.Response(200, json={"choices": [{"message": {"content": "answer"}}]})

        self.assertEqual(self.complete(handler, "other-model"), "answer")

    def test_idle_timeout_is_reported_as_provider_error(self):
        def handler(request):
            raise httpx.ReadTimeout("read timed out", request=request)

        with self.assertRaisesRegex(ProviderRequestError, "waiting for provider activity"):
            self.complete(handler)


if __name__ == "__main__":
    unittest.main()
