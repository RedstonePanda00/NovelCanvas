from __future__ import annotations

from .ai_provider import ProviderRequestError, create_chat_completion
from .generation_common import language_contract, resolve_routed_model
from .model_prompts import apply_model_global_prompt
from .models import CanvasEdge, CanvasNode, EdgeSemantic, ProjectFile


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
    "scene": "STRICT SCENE SOURCE",
    "outline": "STRUCTURE SOURCE FOR SCENE DERIVATION",
    "instruction": "DIRECT INSTRUCTION",
    "character": "CHARACTER REFERENCE",
    "supplemental_info": "SUPPLEMENTAL REFERENCE",
    "paragraph": "CONTINUITY SUMMARY ONLY",
    "container": "CONTAINER REFERENCE",
}

NODE_TYPE_ORDER: dict[str, int] = {
    "scene": 0,
    "outline": 1,
    "instruction": 2,
    "supplemental_info": 3,
    "character": 4,
    "paragraph": 5,
    "container": 6,
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
    note = ""
    if node.type == "paragraph":
        note = (
            "Usage note: this paragraph summary is only for continuity with already-written prose. "
            "Do not treat it as a required beat, target content, or style template.\n"
        )
    if node.type == "scene":
        note = (
            "Usage note: this scene is a strict source for paragraph generation. "
            "Preserve its ordered beats, causality, entry state, exit state, and constraints unless a DIRECT INSTRUCTION explicitly overrides them.\n"
        )
    if node.type == "outline":
        note = (
            "Usage note: this outline is structure for scene derivation. "
            "Do not use it as final prose or dialogue.\n"
        )
    return (
        f"Role: {role}\n"
        f"Title: {node.title}\n"
        f"Type: {node.type}\n"
        f"{tags}"
        f"{note}"
        f"Body:\n{body if body is not None else node.body or ''}"
    ).strip()


async def compress_paragraph_reference(project: ProjectFile, node: CanvasNode) -> str:
    body = (node.body or "").strip()
    if not body:
        return ""

    try:
        routed = resolve_routed_model(project, "contextCompressionModelId", "context compression")
    except ValueError as exc:
        raise ContextAssemblyError(str(exc)) from exc

    try:
        return await create_chat_completion(
            routed.provider,
            routed.registered.modelId,
            apply_model_global_prompt(
                [
                    {
                        "role": "system",
                        "content": (
                            "You compress long paragraph nodes into continuity summaries only. "
                            "Preserve already-established plot facts, character decisions, causality, setting state, tone, and unresolved hooks. "
                            "Do not add new story ideas, do not suggest future beats, and do not imply the next generated content must include every detail. "
                            "Omit decorative portrait wording and repeated signature-feature descriptions unless they affect identification, "
                            "a changed physical condition, or causality. When such a detail matters, summarize it as an already-established fact, "
                            "not as a description to reproduce. Preserve injuries, disguises and other action-relevant physical constraints. "
                            f"Output a concise reference summary only. {language_contract(project)}"
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
                project,
                "contextCompressionModelId",
                routed.registered.id,
            ),
            max_tokens=700,
            json_response=False,
        )
    except ProviderRequestError as exc:
        raise ContextAssemblyError(f"Paragraph reference compression failed: {exc}") from exc


async def format_direct_context(project: ProjectFile, items: list[tuple[CanvasEdge, CanvasNode]]) -> str:
    if not items:
        return "No direct linked context nodes."

    rendered_by_semantic: dict[EdgeSemantic, list[str]] = {}
    for edge, node in sorted(items, key=context_sort_key):
        body = await compress_paragraph_reference(project, node) if node.type == "paragraph" else None
        rendered_by_semantic.setdefault(edge.semantic, []).append(node_context_text(node, body))

    sections: list[str] = []
    for semantic in CONTEXT_SEMANTIC_ORDER:
        rendered_items = rendered_by_semantic.get(semantic)
        if rendered_items:
            section_intro = ""
            if any("Type: paragraph" in item for item in rendered_items):
                section_intro = (
                    "Paragraph entries in this section are continuity summaries only. "
                    "Use them to avoid contradictions, not as content that must be repeated or imitated.\n\n"
                )
            if any("Type: scene" in item for item in rendered_items):
                section_intro += (
                    "Scene entries are strict scene sources. Follow their ordered beats and continuity when generating target paragraphs.\n\n"
                )
            sections.append(f"{SECTION_LABELS[semantic]}:\n" + section_intro + "\n\n".join(rendered_items))

    for semantic, rendered_items in rendered_by_semantic.items():
        if semantic not in CONTEXT_SEMANTIC_ORDER:
            sections.append(f"{SECTION_LABELS.get(semantic, semantic.upper())}:\n" + "\n\n".join(rendered_items))

    return "\n\n---\n\n".join(sections)
