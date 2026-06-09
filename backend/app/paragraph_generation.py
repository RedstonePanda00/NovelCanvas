from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass

from .ai_provider import ProviderRequestError, stream_chat_completion
from .models import AIProviderConfig, CanvasEdge, CanvasNode, EdgeSemantic
from .rag import preview_rag_for_target
from .stores import find_provider, find_registered_model, read_project
from .worldbook import collect_worldbook_entries, format_worldbook_context


class ParagraphGenerationError(RuntimeError):
    pass


@dataclass
class ParagraphGenerationSession:
    provider: AIProviderConfig
    modelId: str
    messages: list[dict[str, str]]


CONTEXT_SEMANTIC_ORDER: list[EdgeSemantic] = [
    "must_follow",
    "instruction",
    "reference",
    "can_rewrite",
    "style_reference",
]

SECTION_LABELS: dict[EdgeSemantic, str] = {
    "must_follow": "MUST FOLLOW",
    "instruction": "WRITING TASK",
    "reference": "REFERENCE",
    "can_rewrite": "CAN REWRITE",
    "style_reference": "STYLE REFERENCE",
    "review_basis": "REVIEW BASIS",
    "review_target": "TEXT TO REVIEW",
}


def _edge_sort_value(edge: CanvasEdge) -> str:
    return edge.metadata.createdAt if edge.metadata else edge.id


def _node_context_text(node: CanvasNode) -> str:
    tags = f"Tags: {', '.join(node.metadata.tags)}\n" if node.metadata.tags else ""
    return f"Title: {node.title}\nType: {node.type}\n{tags}Body:\n{node.body or ''}".strip()


def _collect_direct_context(target_node_id: str) -> tuple[CanvasNode, list[tuple[CanvasEdge, CanvasNode]]]:
    project = read_project()
    node_by_id = {node.id: node for node in project.nodes}
    target = node_by_id.get(target_node_id)
    if target is None:
        raise ParagraphGenerationError(f"Target node not found: {target_node_id}")
    if target.type != "paragraph":
        raise ParagraphGenerationError("Paragraph generation requires a paragraph target node.")

    items: list[tuple[CanvasEdge, CanvasNode]] = []
    for edge in project.edges:
        if edge.targetNodeId != target_node_id:
            continue
        if edge.semantic in {"review_target", "review_basis"}:
            continue

        source = node_by_id.get(edge.sourceNodeId)
        if source is None or source.type == "review":
            continue

        items.append((edge, source))

    items.sort(
        key=lambda item: (
            CONTEXT_SEMANTIC_ORDER.index(item[0].semantic)
            if item[0].semantic in CONTEXT_SEMANTIC_ORDER
            else len(CONTEXT_SEMANTIC_ORDER),
            _edge_sort_value(item[0]),
            item[0].id,
        )
    )
    return target, items


def _format_context(items: list[tuple[CanvasEdge, CanvasNode]]) -> str:
    if not items:
        return "No direct linked context nodes."

    sections: list[str] = []
    for semantic in CONTEXT_SEMANTIC_ORDER:
        semantic_items = [(edge, node) for edge, node in items if edge.semantic == semantic]
        if not semantic_items:
            continue

        body = "\n\n".join(_node_context_text(node) for _, node in semantic_items)
        sections.append(f"{SECTION_LABELS[semantic]}:\n{body}")

    return "\n\n---\n\n".join(sections)


async def _format_rag_context(target_node_id: str) -> str:
    rag = await preview_rag_for_target(target_node_id, 5)
    if not rag.authorized or rag.unavailableReason or not rag.snippets:
        return "No authorized RAG snippets."

    return "\n\n".join(
        f"Document: {snippet.documentTitle}\nScore: {snippet.score:.3f}\n{snippet.text}"
        for snippet in rag.snippets
    )


async def _messages(target: CanvasNode, context_items: list[tuple[CanvasEdge, CanvasNode]]) -> list[dict[str, str]]:
    direct_context = _format_context(context_items)
    rag_context = await _format_rag_context(target.id)
    context_nodes = [node for _, node in context_items]
    worldbook_entries = collect_worldbook_entries(target, context_nodes)
    worldbook_before = format_worldbook_context(worldbook_entries, "before_context")
    worldbook_after = format_worldbook_context(worldbook_entries, "after_context")

    return [
        {
            "role": "system",
            "content": (
                "You are a controlled prose assistant inside a node-based novel writing workspace. "
                "Write only prose for the selected paragraph node. "
                "Use only the triggered worldbook entries, direct linked context, and authorized RAG snippets provided below. "
                "Do not create nodes, do not mention the canvas, and do not include analysis or headings."
            ),
        },
        {
            "role": "user",
            "content": (
                f"TARGET PARAGRAPH:\nTitle: {target.title}\nCurrent body:\n{target.body or ''}\n\n"
                f"WORLDBOOK BEFORE CONTEXT:\n{worldbook_before}\n\n"
                f"DIRECT LINKED CONTEXT:\n{direct_context}\n\n"
                f"WORLDBOOK AFTER CONTEXT:\n{worldbook_after}\n\n"
                f"RAG SUPPLEMENTAL CONTEXT:\n{rag_context}\n\n"
                "Write the paragraph text now. Output prose only."
            ),
        },
    ]


async def prepare_paragraph_generation(target_node_id: str) -> ParagraphGenerationSession:
    project = read_project()
    model_id = project.settings.modelRouting.paragraphGenerationModelId
    if not model_id:
        raise ParagraphGenerationError("No paragraph generation model is selected in project settings.")

    registered_model = find_registered_model(model_id)
    if registered_model is None:
        raise ParagraphGenerationError(f"Paragraph generation model is not registered: {model_id}")

    provider = find_provider(registered_model.providerId)
    if provider is None:
        raise ParagraphGenerationError(f"Provider is not registered: {registered_model.providerId}")

    target, context_items = _collect_direct_context(target_node_id)
    return ParagraphGenerationSession(
        provider=provider,
        modelId=registered_model.modelId,
        messages=await _messages(target, context_items),
    )


async def stream_paragraph_generation(session: ParagraphGenerationSession) -> AsyncIterator[str]:
    try:
        async for chunk in stream_chat_completion(
            session.provider,
            session.modelId,
            session.messages,
            max_tokens=1800,
        ):
            yield chunk
    except ProviderRequestError as exc:
        raise ParagraphGenerationError(str(exc)) from exc
