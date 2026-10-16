from __future__ import annotations

import math

from .context_assembly import CONTEXT_SEMANTIC_ORDER, context_sort_key, node_context_text
from .models import (
    CanvasEdge,
    CanvasNode,
    ContextPreviewExcluded,
    ContextPreviewItem,
    ContextPreviewResponse,
    EdgeSemantic,
    ProjectFile,
)
from .rag import memory_metadata_for_project
from .stores import find_registered_model


def _estimate_tokens(text: str) -> int:
    return max(1, math.ceil(len(text) / 4))


def build_context_preview(project: ProjectFile, target_node_id: str) -> ContextPreviewResponse:
    node_by_id = {node.id: node for node in project.nodes}
    target = node_by_id.get(target_node_id)
    if target is None:
        raise ValueError(f"Target node not found: {target_node_id}")

    mode = "paragraph" if target.type == "paragraph" else "unsupported"
    included: list[tuple[CanvasEdge, CanvasNode]] = []
    excluded: list[ContextPreviewExcluded] = []

    for edge in project.edges:
        if edge.targetNodeId != target.id:
            continue
        source = node_by_id.get(edge.sourceNodeId)
        if source is None:
            excluded.append(
                ContextPreviewExcluded(
                    edgeId=edge.id,
                    reasonCode="missing_source",
                    reason="The source node no longer exists.",
                )
            )
            continue
        if "legacy-review" in source.metadata.tags:
            excluded.append(
                ContextPreviewExcluded(
                    edgeId=edge.id,
                    nodeId=source.id,
                    reasonCode="review_source",
                    reason="Migrated review notes are not automatically used as manuscript facts.",
                )
            )
            continue
        if mode == "paragraph" and edge.semantic in {"review_target", "review_basis"}:
            excluded.append(
                ContextPreviewExcluded(
                    edgeId=edge.id,
                    nodeId=source.id,
                    reasonCode="review_semantic",
                    reason="This legacy review relationship is retained for reference only.",
                )
            )
            continue
        if mode == "unsupported":
            excluded.append(
                ContextPreviewExcluded(
                    edgeId=edge.id,
                    nodeId=source.id,
                    reasonCode="unsupported_target",
                    reason="Context preview is available for paragraph nodes. Use chat read scope for other nodes.",
                )
            )
            continue
        included.append((edge, source))

    order = CONTEXT_SEMANTIC_ORDER
    included.sort(
        key=lambda item: (
            order.index(item[0].semantic) if item[0].semantic in order else len(order),
            *context_sort_key(item)[1:],
        )
    )
    items = [
        ContextPreviewItem(
            edgeId=edge.id,
            nodeId=node.id,
            title=node.title,
            nodeType=node.type,
            semantic=edge.semantic,
            estimatedTokens=_estimate_tokens(node_context_text(node)),
        )
        for edge, node in included
    ]
    route_model_id = project.settings.modelRouting.paragraphGenerationModelId
    routed_model = find_registered_model(route_model_id) if route_model_id else None
    compression_threshold = (
        max(1, int(routed_model.contextWindowTokens * 0.75))
        if routed_model and routed_model.contextWindowTokens
        else 12000
    )
    return ContextPreviewResponse(
        mode=mode,
        items=items,
        excluded=excluded,
        estimatedTokens=sum(item.estimatedTokens for item in items),
        compressionThreshold=compression_threshold,
        memoryStale=memory_metadata_for_project(project).stale,
    )
