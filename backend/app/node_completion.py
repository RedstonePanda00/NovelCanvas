from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass

from .ai_provider import ProviderRequestError, stream_chat_completion
from .context_assembly import ContextAssemblyError, context_sort_key, format_direct_context
from .generation_common import language_contract, resolve_routed_model
from .model_prompts import apply_model_global_prompt
from .models import AIProviderConfig, CanvasEdge, CanvasNode, ProjectFile
from .worldbook import collect_worldbook_entries, format_worldbook_context, worldbook_usage_contract


class NodeCompletionError(RuntimeError):
    pass


@dataclass
class NodeCompletionSession:
    provider: AIProviderConfig
    modelId: str
    messages: list[dict[str, str]]


def _collect_reference_sources(
    project: ProjectFile,
    target_node_id: str,
) -> tuple[CanvasNode, list[tuple[CanvasEdge, CanvasNode]]]:
    node_by_id = {node.id: node for node in project.nodes}
    target = node_by_id.get(target_node_id)
    if target is None:
        raise NodeCompletionError(f"Target node not found: {target_node_id}")
    if target.type != "outline":
        raise NodeCompletionError("Current-node completion is available only for outline nodes.")

    source_items: list[tuple[CanvasEdge, CanvasNode]] = []
    for edge in project.edges:
        if edge.targetNodeId != target_node_id:
            continue
        if edge.semantic != "reference":
            continue
        source = node_by_id.get(edge.sourceNodeId)
        if source is None or "legacy-review" in source.metadata.tags:
            continue
        source_items.append((edge, source))

    source_items.sort(key=context_sort_key)
    trigger_nodes = [node for _, node in source_items]
    if not trigger_nodes:
        raise NodeCompletionError("Current-node completion requires at least one incoming reference source.")

    return target, source_items


def _target_contract(target: CanvasNode) -> str:
    return (
        "Complete an outline node only. Output structured outline content: beats, hierarchy, causality, constraints, "
        "and brief notes. Do not write scene prose, dialogue, narration, or paragraph-style final text."
    )


async def _messages(
    project: ProjectFile,
    target: CanvasNode,
    source_items: list[tuple[CanvasEdge, CanvasNode]],
) -> list[dict[str, str]]:
    source_context = await format_direct_context(project, source_items)
    trigger_nodes = [node for _, node in source_items]
    worldbook_entries = collect_worldbook_entries(project, target, trigger_nodes)
    worldbook_before = format_worldbook_context(worldbook_entries, "before_context")
    worldbook_after = format_worldbook_context(worldbook_entries, "after_context")
    target_label = target.type.replace("_", " ")
    return [
        {
            "role": "system",
            "content": (
                "You are a controlled structure writing assistant inside a node-based novel writing workspace. "
                "Complete only the selected target node body according to its node type. "
                f"{worldbook_usage_contract('structure')}"
                "Use the provided incoming reference sources as the primary basis. "
                "Respect context labels: scene references are primary continuity sources; compressed paragraph references are summaries of prior prose. "
                "Do not create nodes, do not mention the canvas, and do not include analysis outside the target content. "
                f"{language_contract(project)}"
            ),
        },
        {
            "role": "user",
            "content": (
                f"TARGET {target_label.upper()} NODE:\n"
                f"Title: {target.title}\n"
                f"Current body:\n{target.body or ''}\n\n"
                f"OUTPUT CONTRACT:\n{_target_contract(target)}\n\n"
                "Worldbook usage rule: do not force worldbook facts into the output. Use them only to avoid contradictions or fill relevant details.\n\n"
                f"WORLDBOOK BEFORE CONTEXT:\n{worldbook_before}\n\n"
                f"INCOMING REFERENCE SOURCES:\n{source_context}\n\n"
                f"WORLDBOOK AFTER CONTEXT:\n{worldbook_after}\n\n"
                f"Write the completed {target_label} content for the target node. Output only the node body text."
            ),
        },
    ]


async def prepare_node_completion(project: ProjectFile, target_node_id: str) -> NodeCompletionSession:
    try:
        routed = resolve_routed_model(project, "structureDerivationModelId", "structure derivation")
    except ValueError as exc:
        raise NodeCompletionError(str(exc)) from exc

    target, source_items = _collect_reference_sources(project, target_node_id)
    try:
        messages = apply_model_global_prompt(
            await _messages(project, target, source_items),
            project,
            "structureDerivationModelId",
            routed.registered.id,
        )
    except ContextAssemblyError as exc:
        raise NodeCompletionError(str(exc)) from exc
    return NodeCompletionSession(
        provider=routed.provider,
        modelId=routed.registered.modelId,
        messages=messages,
    )


async def stream_node_completion(session: NodeCompletionSession) -> AsyncIterator[str]:
    try:
        async for chunk in stream_chat_completion(
            session.provider,
            session.modelId,
            session.messages,
            max_tokens=1800,
        ):
            yield chunk
    except ProviderRequestError as exc:
        raise NodeCompletionError(str(exc)) from exc
