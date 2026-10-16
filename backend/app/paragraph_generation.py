from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass

from .ai_provider import ProviderRequestError, stream_chat_completion
from .context_assembly import (
    ContextAssemblyError,
    context_sort_key,
    format_direct_context,
)
from .generation_common import language_contract, resolve_routed_model
from .model_prompts import apply_model_global_prompt
from .models import AIProviderConfig, CanvasEdge, CanvasNode, ProjectFile
from .rag import preview_rag_for_target
from .worldbook import collect_worldbook_entries, format_worldbook_context, worldbook_usage_contract


class ParagraphGenerationError(RuntimeError):
    pass


@dataclass
class ParagraphGenerationSession:
    provider: AIProviderConfig
    modelId: str
    messages: list[dict[str, str]]


def _collect_direct_context(
    project: ProjectFile,
    target_node_id: str,
) -> tuple[CanvasNode, list[tuple[CanvasEdge, CanvasNode]]]:
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
        if source is None or "legacy-review" in source.metadata.tags:
            continue

        items.append((edge, source))

    items.sort(key=context_sort_key)
    return target, items


async def _format_rag_context(project: ProjectFile, target_node_id: str) -> str:
    rag = await preview_rag_for_target(project, target_node_id, 5)
    if not rag.authorized or rag.unavailableReason or not rag.snippets:
        return rag.unavailableReason or "No project memory snippets."

    return "\n\n".join(
        f"Memory source: {snippet.documentTitle}\nScore: {snippet.score:.3f}\n{snippet.text}"
        for snippet in rag.snippets
    )


async def _messages(
    project: ProjectFile,
    target: CanvasNode,
    context_items: list[tuple[CanvasEdge, CanvasNode]],
    mode: str,
) -> list[dict[str, str]]:
    direct_context = await format_direct_context(project, context_items)
    rag_context = await _format_rag_context(project, target.id)
    context_nodes = [node for _, node in context_items]
    worldbook_entries = collect_worldbook_entries(project, target, context_nodes)
    worldbook_before = format_worldbook_context(worldbook_entries, "before_context")
    worldbook_after = format_worldbook_context(worldbook_entries, "after_context")
    current_body = (target.body or "").strip()

    if mode == "append":
        mode_contract = (
            "GENERATION MODE: append\n"
            "The target paragraph already contains text shown in Current body. Treat it as continuity reference.\n"
            "Output ONLY the new continuation prose that should be added after Current body.\n"
            "Do not repeat, paraphrase, or re-output sentences already present in Current body.\n"
            "Do not output the full paragraph. Output only the appended continuation."
        )
        if not current_body:
            mode_contract = (
                "GENERATION MODE: append\n"
                "Current body is empty, so write the opening paragraph prose from scratch.\n"
                "Because there is no existing text yet, output the full paragraph text for this node."
            )
    else:
        mode_contract = (
            "GENERATION MODE: replace\n"
            "Use Current body as draft/reference material when it exists.\n"
            "Output one complete replacement paragraph for this node.\n"
            "You may revise, delete, reorder, or rewrite any part of Current body, but the output must be the full final paragraph, not a continuation."
        )
        if not current_body:
            mode_contract = (
                "GENERATION MODE: replace\n"
                "Current body is empty, so write the full paragraph prose from scratch.\n"
                "Output the complete paragraph text for this node."
            )

    return [
        {
            "role": "system",
            "content": (
                "You are a controlled prose assistant inside a node-based novel writing workspace. "
                "The target node type is paragraph. Follow the generation mode contract exactly. "
                "Use only the triggered worldbook entries, direct linked context, project memory snippets, and Current body provided below when they are relevant. "
                f"{worldbook_usage_contract('prose')}"
                "Scene references are strict source material for this paragraph: preserve their ordered beats, causality, entry state, exit state, and explicit constraints. "
                "Do not freely invent a different scene direction unless a DIRECT INSTRUCTION explicitly asks for a change. "
                "Compressed paragraph references are prior prose context, not a style to copy blindly. "
                "Project memory snippets are semantic continuity reminders from already-written project nodes; do not copy them verbatim unless the content truly belongs here. "
                "Do not write outlines, plans, labels, headings, analysis, reviews, or canvas commentary. "
                f"{language_contract(project)}"
            ),
        },
        {
            "role": "user",
            "content": (
                f"TARGET PARAGRAPH:\nTitle: {target.title}\n\n"
                f"{mode_contract}\n\n"
                f"Current body:\n{target.body or '[empty]'}\n\n"
                "Worldbook usage rule: consult entries only when they are relevant to this paragraph. "
                "Do not mention or include worldbook facts merely because they are present.\n\n"
                f"WORLDBOOK BEFORE CONTEXT:\n{worldbook_before}\n\n"
                f"DIRECT LINKED CONTEXT:\n{direct_context}\n\n"
                f"WORLDBOOK AFTER CONTEXT:\n{worldbook_after}\n\n"
                f"PROJECT MEMORY RAG:\n{rag_context}\n\n"
                "Write now. Output prose only."
            ),
        },
    ]


async def prepare_paragraph_generation(
    project: ProjectFile,
    target_node_id: str,
    mode: str = "replace",
) -> ParagraphGenerationSession:
    try:
        routed = resolve_routed_model(project, "paragraphGenerationModelId", "paragraph generation")
    except ValueError as exc:
        raise ParagraphGenerationError(str(exc)) from exc

    target, context_items = _collect_direct_context(project, target_node_id)
    try:
        messages = apply_model_global_prompt(
            await _messages(project, target, context_items, mode),
            project,
            "paragraphGenerationModelId",
            routed.registered.id,
        )
    except ContextAssemblyError as exc:
        raise ParagraphGenerationError(str(exc)) from exc
    return ParagraphGenerationSession(
        provider=routed.provider,
        modelId=routed.registered.modelId,
        messages=messages,
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
