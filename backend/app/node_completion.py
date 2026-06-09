from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass

from .ai_provider import ProviderRequestError, stream_chat_completion
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


def _edge_sort_value(edge: CanvasEdge) -> str:
    return edge.metadata.createdAt if edge.metadata else edge.id


def _node_context_text(node: CanvasNode) -> str:
    tags = f"Tags: {', '.join(node.metadata.tags)}\n" if node.metadata.tags else ""
    return f"Title: {node.title}\nType: {node.type}\n{tags}Body:\n{node.body or ''}".strip()


def _collect_reference_sources(target_node_id: str) -> tuple[CanvasNode, list[CanvasNode], list[CanvasNode]]:
    project = read_project()
    node_by_id = {node.id: node for node in project.nodes}
    target = node_by_id.get(target_node_id)
    if target is None:
        raise NodeCompletionError(f"Target node not found: {target_node_id}")
    if target.type not in {"outline", "scene"}:
        raise NodeCompletionError("Current-node completion is available only for outline and scene nodes.")

    source_items: list[tuple[CanvasEdge, CanvasNode]] = []
    for edge in project.edges:
        if edge.targetNodeId != target_node_id or edge.semantic != "reference":
            continue
        source = node_by_id.get(edge.sourceNodeId)
        if source is None or source.type == "review":
            continue
        source_items.append((edge, source))

    source_items.sort(key=lambda item: (_edge_sort_value(item[0]), item[0].id))
    trigger_nodes = [node for _, node in source_items]
    if not trigger_nodes:
        raise NodeCompletionError("Current-node completion requires at least one incoming reference source.")

    source_nodes = [node for node in trigger_nodes if node.type != "character"]
    upsert_character_nodes_as_worldbook_entries(trigger_nodes)
    return target, source_nodes, trigger_nodes


def _messages(target: CanvasNode, source_nodes: list[CanvasNode], trigger_nodes: list[CanvasNode]) -> list[dict[str, str]]:
    source_context = "\n\n---\n\n".join(_node_context_text(node) for node in source_nodes) or "No non-character reference sources."
    worldbook_entries = collect_worldbook_entries(target, trigger_nodes)
    worldbook_before = format_worldbook_context(worldbook_entries, "before_context")
    worldbook_after = format_worldbook_context(worldbook_entries, "after_context")
    target_label = target.type.replace("_", " ")
    return [
        {
            "role": "system",
            "content": (
                "You are a controlled structure writing assistant inside a node-based novel writing workspace. "
                "Complete only the selected target node body. Use only the triggered worldbook entries and provided incoming reference sources. "
                "Do not create nodes, do not mention the canvas, and do not include analysis."
            ),
        },
        {
            "role": "user",
            "content": (
                f"TARGET {target_label.upper()} NODE:\n"
                f"Title: {target.title}\n"
                f"Current body:\n{target.body or ''}\n\n"
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

    target, source_nodes, trigger_nodes = _collect_reference_sources(target_node_id)
    return NodeCompletionSession(
        provider=provider,
        modelId=registered_model.modelId,
        messages=_messages(target, source_nodes, trigger_nodes),
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
