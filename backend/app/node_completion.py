from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass

from .ai_provider import ProviderRequestError, stream_chat_completion
from .context_assembly import ContextAssemblyError, context_sort_key, format_direct_context
from .models import AIProviderConfig, CanvasEdge, CanvasNode
from .stores import find_provider, find_registered_model, read_project
from .worldbook import collect_worldbook_entries, format_worldbook_context, upsert_character_nodes_as_worldbook_entries


class NodeCompletionError(RuntimeError):
    pass


@dataclass
class NodeCompletionSession:
    provider: AIProviderConfig
    modelId: str
    messages: list[dict[str, str]]


def _collect_reference_sources(target_node_id: str) -> tuple[CanvasNode, list[tuple[CanvasEdge, CanvasNode]], list[CanvasNode]]:
    project = read_project()
    node_by_id = {node.id: node for node in project.nodes}
    target = node_by_id.get(target_node_id)
    if target is None:
        raise NodeCompletionError(f"Target node not found: {target_node_id}")
    if target.type not in {"outline", "scene"}:
        raise NodeCompletionError("Current-node completion is available only for outline and scene nodes.")

    source_items: list[tuple[CanvasEdge, CanvasNode]] = []
    for edge in project.edges:
        if edge.targetNodeId != target_node_id:
            continue
        if edge.semantic in {"review_target", "review_basis"}:
            continue
        source = node_by_id.get(edge.sourceNodeId)
        if source is None or source.type == "review":
            continue
        source_items.append((edge, source))

    source_items.sort(key=context_sort_key)
    trigger_nodes = [node for _, node in source_items]
    if not trigger_nodes:
        raise NodeCompletionError("Current-node completion requires at least one incoming reference source.")

    upsert_character_nodes_as_worldbook_entries(trigger_nodes)
    return target, [(edge, node) for edge, node in source_items if node.type != "character"], trigger_nodes


def _target_contract(target: CanvasNode) -> str:
    if target.type == "outline":
        return (
            "Complete an outline node only. Output structured outline content: beats, hierarchy, causality, constraints, "
            "and brief notes. Do not write scene prose, dialogue, narration, or paragraph-style final text."
        )
    return (
        "Complete a scene node only. Output a scene plan: purpose, conflict, sequence of beats, character movement, "
        "setting continuity, and handoff to paragraphs. Do not write final prose paragraphs or dialogue passages."
    )


async def _messages(
    target: CanvasNode,
    source_items: list[tuple[CanvasEdge, CanvasNode]],
    trigger_nodes: list[CanvasNode],
) -> list[dict[str, str]]:
    source_context = await format_direct_context(source_items)
    worldbook_entries = collect_worldbook_entries(target, trigger_nodes)
    worldbook_before = format_worldbook_context(worldbook_entries, "before_context")
    worldbook_after = format_worldbook_context(worldbook_entries, "after_context")
    target_label = target.type.replace("_", " ")
    return [
        {
            "role": "system",
            "content": (
                "You are a controlled structure writing assistant inside a node-based novel writing workspace. "
                "Complete only the selected target node body according to its node type. "
                "Use only the triggered worldbook entries and provided incoming reference sources. "
                "Respect context labels: scene references are primary continuity sources; compressed paragraph references are summaries of prior prose. "
                "Do not create nodes, do not mention the canvas, and do not include analysis outside the target content."
            ),
        },
        {
            "role": "user",
            "content": (
                f"TARGET {target_label.upper()} NODE:\n"
                f"Title: {target.title}\n"
                f"Current body:\n{target.body or ''}\n\n"
                f"OUTPUT CONTRACT:\n{_target_contract(target)}\n\n"
                f"WORLDBOOK BEFORE CONTEXT:\n{worldbook_before}\n\n"
                f"INCOMING REFERENCE SOURCES:\n{source_context}\n\n"
                f"WORLDBOOK AFTER CONTEXT:\n{worldbook_after}\n\n"
                f"Write the completed {target_label} content for the target node. Output only the node body text."
            ),
        },
    ]


async def prepare_node_completion(target_node_id: str) -> NodeCompletionSession:
    project = read_project()
    model_id = project.settings.modelRouting.structureDerivationModelId
    if not model_id:
        raise NodeCompletionError("No structure derivation model is selected in project settings.")

    registered_model = find_registered_model(model_id)
    if registered_model is None:
        raise NodeCompletionError(f"Structure derivation model is not registered: {model_id}")

    provider = find_provider(registered_model.providerId)
    if provider is None:
        raise NodeCompletionError(f"Provider is not registered: {registered_model.providerId}")

    target, source_items, trigger_nodes = _collect_reference_sources(target_node_id)
    try:
        messages = await _messages(target, source_items, trigger_nodes)
    except ContextAssemblyError as exc:
        raise NodeCompletionError(str(exc)) from exc
    return NodeCompletionSession(
        provider=provider,
        modelId=registered_model.modelId,
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
