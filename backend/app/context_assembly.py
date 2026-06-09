from __future__ import annotations

from .ai_provider import ProviderRequestError, create_chat_completion
from .models import CanvasEdge, CanvasNode, EdgeSemantic
from .stores import find_provider, find_registered_model, read_project


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

NODE_CONTEXT_ROLE: dict[str, str] = {
    "scene": "PRIMARY SCENE REFERENCE",
    "outline": "STRUCTURE REFERENCE",
    "instruction": "DIRECT INSTRUCTION",
    "character": "CHARACTER REFERENCE",
    "supplemental_info": "SUPPLEMENTAL REFERENCE",
    "paragraph": "COMPRESSED PARAGRAPH REFERENCE",
    "container": "CONTAINER REFERENCE",
    "generic": "GENERAL REFERENCE",
    "review": "REVIEW REFERENCE",
}

NODE_TYPE_ORDER: dict[str, int] = {
    "scene": 0,
    "outline": 1,
    "instruction": 2,
    "supplemental_info": 3,
    "character": 4,
    "paragraph": 5,
    "container": 6,
    "generic": 7,
}


class ContextAssemblyError(RuntimeError):
    pass


def edge_sort_value(edge: CanvasEdge) -> str:
    return edge.metadata.createdAt if edge.metadata else edge.id


def context_sort_key(item: tuple[CanvasEdge, CanvasNode]) -> tuple[int, int, str, str]:
    edge, node = item
    semantic_index = (
        CONTEXT_SEMANTIC_ORDER.index(edge.semantic)
        if edge.semantic in CONTEXT_SEMANTIC_ORDER
        else len(CONTEXT_SEMANTIC_ORDER)
    )
    return (
        semantic_index,
        NODE_TYPE_ORDER.get(node.type, 99),
        edge_sort_value(edge),
        edge.id,
    )


def node_context_text(node: CanvasNode, body: str | None = None) -> str:
    tags = f"Tags: {', '.join(node.metadata.tags)}\n" if node.metadata.tags else ""
    role = NODE_CONTEXT_ROLE.get(node.type, "REFERENCE")
    return (
        f"Role: {role}\n"
        f"Title: {node.title}\n"
        f"Type: {node.type}\n"
        f"{tags}"
        f"Body:\n{body if body is not None else node.body or ''}"
    ).strip()


async def compress_paragraph_reference(node: CanvasNode) -> str:
    body = (node.body or "").strip()
    if not body:
        return ""

    project = read_project()
    model_id = project.settings.modelRouting.contextCompressionModelId
    if not model_id:
        raise ContextAssemblyError("Paragraph reference compression requires a context compression model in Settings.")

    registered_model = find_registered_model(model_id)
    if registered_model is None:
        raise ContextAssemblyError(f"Context compression model is not registered: {model_id}")

    provider = find_provider(registered_model.providerId)
    if provider is None:
        raise ContextAssemblyError(f"Provider is not registered: {registered_model.providerId}")

    try:
        return await create_chat_completion(
            provider,
            registered_model.modelId,
            [
                {
                    "role": "system",
                    "content": (
                        "You compress long paragraph nodes for use as writing context. "
                        "Preserve plot facts, character decisions, causality, setting details, tone, and unresolved hooks. "
                        "Do not continue the story. Output a concise reference summary only."
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"Paragraph title: {node.title}\n"
                        f"Tags: {', '.join(node.metadata.tags)}\n\n"
                        f"Paragraph body:\n{body}"
                    ),
                },
            ],
            max_tokens=700,
            json_response=False,
        )
    except ProviderRequestError as exc:
        raise ContextAssemblyError(f"Paragraph reference compression failed: {exc}") from exc


async def format_direct_context(items: list[tuple[CanvasEdge, CanvasNode]]) -> str:
    if not items:
        return "No direct linked context nodes."

    rendered_by_semantic: dict[EdgeSemantic, list[str]] = {}
    for edge, node in sorted(items, key=context_sort_key):
        body = await compress_paragraph_reference(node) if node.type == "paragraph" else None
        rendered_by_semantic.setdefault(edge.semantic, []).append(node_context_text(node, body))

    sections: list[str] = []
    for semantic in CONTEXT_SEMANTIC_ORDER:
        rendered_items = rendered_by_semantic.get(semantic)
        if rendered_items:
            sections.append(f"{SECTION_LABELS[semantic]}:\n" + "\n\n".join(rendered_items))

    for semantic, rendered_items in rendered_by_semantic.items():
        if semantic not in CONTEXT_SEMANTIC_ORDER:
            sections.append(f"{SECTION_LABELS.get(semantic, semantic.upper())}:\n" + "\n\n".join(rendered_items))

    return "\n\n---\n\n".join(sections)
