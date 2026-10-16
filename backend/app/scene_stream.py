from __future__ import annotations

import json
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .ai_provider import stream_chat_completion
from .generation_common import resolve_routed_model
from .json_stream import event_line, partial_json
from .model_prompts import apply_model_global_prompt
from .models import ProjectFile
from .structure_plans import _prompt

router = APIRouter(prefix="/api/plans")


class SceneStreamRequest(BaseModel):
    project: ProjectFile
    sourceNodeIds: list[str] = Field(min_length=1, max_length=100)
    desiredCount: int = Field(ge=1, le=12)


@router.post("/scenes/stream")
def stream_scenes(request: SceneStreamRequest) -> StreamingResponse:
    by_id = {node.id: node for node in request.project.nodes}
    if any(node_id not in by_id for node_id in request.sourceNodeIds):
        raise HTTPException(400, "A selected source no longer exists.")
    sources = [by_id[node_id] for node_id in dict.fromkeys(request.sourceNodeIds)]
    if sources[0].type != "outline":
        raise HTTPException(400, "Scene generation requires an outline as its primary source.")
    try:
        routed = resolve_routed_model(request.project, "structureDerivationModelId", "structure derivation")
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    messages = apply_model_global_prompt(_prompt(request.project, "generate-scenes", sources, sources, request.desiredCount), request.project, "structureDerivationModelId", routed.registered.id)
    messages.append({"role": "user", "content": f"The application has already reserved exactly {request.desiredCount} scene slots. Fill ALL slots in story order. Return JSON {{\"nodes\":[{{\"type\":\"scene\",\"title\":\"...\",\"body\":\"complete scene brief\"}}]}} with exactly {request.desiredCount} entries. No edges are needed; the application links these slots to the outline. Write each complete title and body before starting the next entry. This exact slot count overrides any general node-count suggestion above."})
    max_tokens = min(16000, max(2500, request.desiredCount * 1200))
    if routed.registered.contextWindowTokens and sum(len(m["content"]) for m in messages) > max(1, routed.registered.contextWindowTokens - max_tokens):
        raise HTTPException(400, "场景参考内容过长，请减少参考或生成数量 / Scene context is too large.")

    async def events():
        raw = ""
        previous = None
        try:
            async for chunk in stream_chat_completion(routed.provider, routed.registered.modelId, messages, max_tokens=max_tokens, json_response=True):
                raw += chunk
                if len(raw) > 500000:
                    raise ValueError("Scene output exceeded the preview limit.")
                partial = partial_json(raw)
                nodes = partial.get("nodes") if isinstance(partial, dict) else None
                if isinstance(nodes, list):
                    previews = [{key: item.get(key) if isinstance(item, dict) and isinstance(item.get(key), str) else "" for key in ("title", "body")} for item in nodes[:request.desiredCount]]
                    line = event_line({"type": "preview", "nodes": previews})
                    if line != previous:
                        yield line
                        previous = line
            payload = json.loads(raw)
            nodes = payload.get("nodes") if isinstance(payload, dict) else None
            if not isinstance(nodes, list) or len(nodes) != request.desiredCount:
                raise ValueError("模型返回的场景数量与预建节点不符 / Scene count does not match reserved slots.")
            if any(not isinstance(node, dict) or node.get("type", "scene") != "scene" or any(not isinstance(node.get(key), str) or not node[key].strip() for key in ("title", "body")) for node in nodes):
                raise ValueError("模型未完成所有场景 / Some scene slots are incomplete.")
            yield event_line({"type": "done", "nodes": [{"title": node["title"], "body": node["body"]} for node in nodes]})
        except Exception as exc:
            yield event_line({"type": "error", "error": {"code": "scene_stream_failed", "message": str(exc)}})

    return StreamingResponse(events(), media_type="application/x-ndjson", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
