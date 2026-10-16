from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from .ai_provider import stream_chat_completion
from .assistant_workbench import AssistantRequest, build_messages, parse_assistant_response
from .json_stream import event_line, partial_json
from .stores import read_local_app_config
from .project_agent import project_agent_events

router = APIRouter(prefix="/api/assistant")


@router.post("/stream")
def stream_assistant(request: AssistantRequest) -> StreamingResponse:
    config = read_local_app_config()
    model = next((m for m in config.registeredModels if m.id == config.chatModelId and m.enabled), None)
    if model is None or not set(model.capabilityTags) - {"embedding"}:
        raise HTTPException(400, "请先在设置中选择聊天模型 / Select a chat model in Settings.")
    provider = next((p for p in config.providers if p.id == model.providerId), None)
    if provider is None:
        raise HTTPException(400, "Chat model provider is unavailable.")
    if request.scope == "project":
        async def project_events():
            try:
                async for event in project_agent_events(request, provider, model):
                    yield event_line(event)
            except Exception as exc:
                yield event_line({"type": "error", "error": {"code": "agent_failed", "message": str(exc)}})
        return StreamingResponse(project_events(), media_type="application/x-ndjson",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
    try:
        messages, context = build_messages(request)
        if model.contextWindowTokens and sum(len(m["content"]) for m in messages) > max(1, model.contextWindowTokens - 4000):
            raise ValueError("参考内容过长，请减少参考节点或讨论历史 / Context is too large.")
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    async def events():
        raw = ""
        previous = None
        try:
            async for chunk in stream_chat_completion(provider, model.modelId, messages, max_tokens=4000, json_response=True):
                raw += chunk
                if len(raw) > 500000:
                    raise ValueError("Assistant output exceeded the preview limit.")
                partial = partial_json(raw)
                if isinstance(partial, dict):
                    preview = {"type": "preview", "reply": partial.get("reply") if isinstance(partial.get("reply"), str) else "", "blocks": [], "edits": []}
                    for field in ("blocks", "edits"):
                        items = partial.get(field)
                        if isinstance(items, list):
                            preview[field] = [{key: item.get(key) if isinstance(item.get(key), str) else "" for key in ("title", "body")} for item in items[:12] if isinstance(item, dict)]
                    line = event_line(preview)
                    if line != previous:
                        yield line
                        previous = line
            result = parse_assistant_response(request, raw, context)
            yield event_line({"type": "done", "response": result.model_dump()})
        except Exception as exc:
            yield event_line({"type": "error", "error": {"code": "assistant_stream_failed", "message": str(exc)}})

    return StreamingResponse(events(), media_type="application/x-ndjson", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
