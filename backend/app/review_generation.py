from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass

from .ai_provider import ProviderRequestError, stream_chat_completion
from .models import AIProviderConfig, CanvasEdge, CanvasNode, EdgeSemantic
from .stores import find_provider, find_registered_model, read_project
from .worldbook import collect_worldbook_entries, format_worldbook_context


class ReviewGenerationError(RuntimeError):
    pass


@dataclass
class ReviewGenerationSession:
    provider: AIProviderConfig
    modelId: str
    messages: list[dict[str, str]]


REVIEW_CONTEXT_ORDER: list[EdgeSemantic] = [
    "review_target",
    "review_basis",
    "must_follow",
    "style_reference",
]

SECTION_LABELS: dict[EdgeSemantic, str] = {
    "review_target": "TEXT TO REVIEW",
    "review_basis": "REVIEW BASIS",
    "must_follow": "MUST FOLLOW",
    "style_reference": "STYLE REFERENCE",
    "instruction": "INSTRUCTION",
    "reference": "REFERENCE",
    "can_rewrite": "CAN REWRITE",
}


def _edge_sort_value(edge: CanvasEdge) -> str:
    return edge.metadata.createdAt if edge.metadata else edge.id


def _node_context_text(node: CanvasNode) -> str:
    tags = f"Tags: {', '.join(node.metadata.tags)}\n" if node.metadata.tags else ""
    return f"Title: {node.title}\nType: {node.type}\n{tags}Body:\n{node.body or ''}".strip()


def _collect_review_context(target_node_id: str) -> tuple[CanvasNode, list[tuple[CanvasEdge, CanvasNode]]]:
    project = read_project()
    node_by_id = {node.id: node for node in project.nodes}
    target = node_by_id.get(target_node_id)
    if target is None:
        raise ReviewGenerationError(f"Review node not found: {target_node_id}")
    if target.type != "review":
        raise ReviewGenerationError("Review generation requires a review target node.")

    items: list[tuple[CanvasEdge, CanvasNode]] = []
    for edge in project.edges:
        if edge.targetNodeId != target_node_id or edge.semantic not in REVIEW_CONTEXT_ORDER:
            continue

        source = node_by_id.get(edge.sourceNodeId)
        if source is None or source.type == "review":
            continue

        items.append((edge, source))

    items.sort(
        key=lambda item: (
            REVIEW_CONTEXT_ORDER.index(item[0].semantic),
            _edge_sort_value(item[0]),
            item[0].id,
        )
    )

    if not any(edge.semantic == "review_target" for edge, _ in items):
        raise ReviewGenerationError("Review generation requires at least one incoming review_target edge.")

    return target, items


def _format_context(items: list[tuple[CanvasEdge, CanvasNode]]) -> str:
    sections: list[str] = []
    for semantic in REVIEW_CONTEXT_ORDER:
        semantic_items = [(edge, node) for edge, node in items if edge.semantic == semantic]
        if not semantic_items:
            continue

        body = "\n\n".join(_node_context_text(node) for _, node in semantic_items)
        sections.append(f"{SECTION_LABELS[semantic]}:\n{body}")

    return "\n\n---\n\n".join(sections)


def _messages(target: CanvasNode, context_items: list[tuple[CanvasEdge, CanvasNode]]) -> list[dict[str, str]]:
    context_nodes = [node for _, node in context_items]
    worldbook_entries = collect_worldbook_entries(target, context_nodes)
    worldbook_before = format_worldbook_context(worldbook_entries, "before_context")
    worldbook_after = format_worldbook_context(worldbook_entries, "after_context")
    return [
        {
            "role": "system",
            "content": (
                "You are a controlled review assistant inside a node-based novel writing workspace. "
                "Write review text only into the selected Review node. "
                "Do not rewrite the target paragraph. Do not create nodes. "
                "Use only the triggered worldbook entries and directly linked review context provided below."
            ),
        },
        {
            "role": "user",
            "content": (
                f"SELECTED REVIEW NODE:\nTitle: {target.title}\nCurrent review body:\n{target.body or ''}\n\n"
                f"WORLDBOOK BEFORE CONTEXT:\n{worldbook_before}\n\n"
                f"DIRECT REVIEW CONTEXT:\n{_format_context(context_items)}\n\n"
                f"WORLDBOOK AFTER CONTEXT:\n{worldbook_after}\n\n"
                "Write a concise, actionable review. Include continuity, character, style, and rule issues only when supported by the linked basis. "
                "Output review text only."
            ),
        },
    ]


async def prepare_review_generation(target_node_id: str) -> ReviewGenerationSession:
    project = read_project()
    model_id = project.settings.modelRouting.reviewModelId
    if not model_id:
        raise ReviewGenerationError("No review model is selected in project settings.")

    registered_model = find_registered_model(model_id)
    if registered_model is None:
        raise ReviewGenerationError(f"Review model is not registered: {model_id}")

    provider = find_provider(registered_model.providerId)
    if provider is None:
        raise ReviewGenerationError(f"Provider is not registered: {registered_model.providerId}")

    target, context_items = _collect_review_context(target_node_id)
    return ReviewGenerationSession(
        provider=provider,
        modelId=registered_model.modelId,
        messages=_messages(target, context_items),
    )


async def stream_review_generation(session: ReviewGenerationSession) -> AsyncIterator[str]:
    try:
        async for chunk in stream_chat_completion(
            session.provider,
            session.modelId,
            session.messages,
            max_tokens=1400,
        ):
            yield chunk
    except ProviderRequestError as exc:
        raise ReviewGenerationError(str(exc)) from exc
