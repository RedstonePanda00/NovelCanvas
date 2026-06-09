from __future__ import annotations

import json
import re
import uuid
from datetime import UTC, datetime
from typing import Any

from pydantic import ValidationError

from .ai_provider import ProviderRequestError, create_chat_completion
from .models import (
    AIGenerationPlan,
    CanvasEdge,
    CanvasNode,
    EdgeMetadata,
    EdgeSemantic,
    NodeMetadata,
    NodeType,
    Point,
    Size,
    StructureWorkflow,
)
from .stores import find_provider, find_registered_model, read_project
from .worldbook import collect_worldbook_entries, format_worldbook_context, upsert_character_nodes_as_worldbook_entries


class StructurePlanError(RuntimeError):
    pass


ALLOWED_NODE_TYPES: set[str] = {
    "paragraph",
    "outline",
    "scene",
    "character",
    "supplemental_info",
    "instruction",
    "review",
    "container",
    "generic",
}

ALLOWED_EDGE_SEMANTICS: set[str] = {
    "must_follow",
    "instruction",
    "reference",
    "can_rewrite",
    "style_reference",
    "review_basis",
    "review_target",
}

WORKFLOW_DEFAULT_TYPE: dict[StructureWorkflow, NodeType] = {
    "generate-outline": "outline",
    "generate-scenes": "scene",
    "generate-paragraph-tasks": "paragraph",
    "create-review-node": "review",
}


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _extract_json_object(text: str) -> dict[str, Any]:
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, flags=re.DOTALL)
        if not match:
            raise StructurePlanError("The model did not return a JSON object.")
        try:
            payload = json.loads(match.group(0))
        except json.JSONDecodeError as exc:
            raise StructurePlanError(f"The model returned invalid JSON: {exc}") from exc

    if not isinstance(payload, dict):
        raise StructurePlanError("The model returned JSON, but it was not an object.")
    return payload


def _node_type(value: Any, workflow: StructureWorkflow) -> NodeType:
    if isinstance(value, str) and value in ALLOWED_NODE_TYPES:
        return value  # type: ignore[return-value]
    return WORKFLOW_DEFAULT_TYPE[workflow]


def _edge_semantic(value: Any, workflow: StructureWorkflow) -> EdgeSemantic:
    if isinstance(value, str) and value in ALLOWED_EDGE_SEMANTICS:
        return value  # type: ignore[return-value]
    if workflow == "create-review-node":
        return "review_target"
    if workflow == "generate-paragraph-tasks":
        return "instruction"
    return "reference"


def _workflow_instructions(workflow: StructureWorkflow) -> str:
    if workflow == "generate-outline":
        return "Create outline nodes derived from the selected source assets. Use type outline."
    if workflow == "generate-scenes":
        return "Create scene nodes derived from the selected outline/source assets. Use type scene."
    if workflow == "generate-paragraph-tasks":
        return (
            "Create executable paragraph placeholder nodes and instruction nodes. Paragraph node bodies should be empty; "
            "instruction nodes should contain narrative task, constraints, and target direction."
        )
    return (
        "Create one review node and suggested review_target/review_basis edges based on the selected paragraph and basis assets. "
        "The review node body should be empty."
    )


def _source_context(source_nodes: list[CanvasNode]) -> str:
    parts: list[str] = []
    for node in source_nodes:
        parts.append(
            "\n".join(
                [
                    f"ID: {node.id}",
                    f"TYPE: {node.type}",
                    f"TITLE: {node.title}",
                    f"TAGS: {', '.join(node.metadata.tags)}",
                    f"BODY:\n{node.body or ''}",
                ]
            )
        )
    return "\n\n---\n\n".join(parts)


def _prompt(workflow: StructureWorkflow, source_nodes: list[CanvasNode], trigger_nodes: list[CanvasNode]) -> list[dict[str, str]]:
    target_for_scan = source_nodes[0] if source_nodes else trigger_nodes[0]
    worldbook_entries = collect_worldbook_entries(target_for_scan, trigger_nodes)
    worldbook_context = "\n\n".join(
        [
            "WORLDBOOK BEFORE CONTEXT:",
            format_worldbook_context(worldbook_entries, "before_context"),
            "WORLDBOOK AFTER CONTEXT:",
            format_worldbook_context(worldbook_entries, "after_context"),
        ]
    )
    return [
        {
            "role": "system",
            "content": (
                "You are a controlled structure derivation assistant inside Novel Canvas. "
                "You may only create a pending plan from the triggered worldbook entries and provided source nodes. "
                "Do not claim anything as canon. Do not write final prose. "
                "Return only a JSON object."
            ),
        },
        {
            "role": "user",
            "content": (
                f"Workflow: {workflow}\n"
                f"{_workflow_instructions(workflow)}\n\n"
                "Return this exact JSON shape:\n"
                "{\n"
                '  "nodes": [\n'
                '    {"tempId":"n1","type":"outline|scene|paragraph|instruction|review|generic","title":"...","body":"...","tags":["draft","ai"]}\n'
                "  ],\n"
                '  "edges": [\n'
                '    {"source":"existing source node id or tempId","target":"existing source node id or tempId","semantic":"reference|must_follow|instruction|review_target|review_basis|style_reference|can_rewrite","label":"optional"}\n'
                "  ]\n"
                "}\n\n"
                "Rules:\n"
                "- Use existing source node ids exactly when connecting from provided non-character source nodes.\n"
                "- Character source nodes are represented through Worldbook entries; do not create edges from character node ids.\n"
                "- Use tempId only for planned nodes you create.\n"
                "- Keep paragraph and review node body empty.\n"
                "- Keep the plan concise for MVP: 1-8 nodes.\n\n"
                f"{worldbook_context}\n\n"
                f"Source nodes:\n{_source_context(source_nodes) or 'No non-character source nodes.'}"
            ),
        },
    ]


def _build_plan(
    workflow: StructureWorkflow,
    source_node_ids: list[str],
    source_nodes: list[CanvasNode],
    model_payload: dict[str, Any],
) -> AIGenerationPlan:
    plan_id = f"plan-{uuid.uuid4()}"
    timestamp = _now_iso()
    raw_nodes = model_payload.get("nodes", [])
    raw_edges = model_payload.get("edges", [])
    if not isinstance(raw_nodes, list):
        raise StructurePlanError("Plan JSON field 'nodes' must be an array.")
    if not isinstance(raw_edges, list):
        raise StructurePlanError("Plan JSON field 'edges' must be an array.")

    source_positions = [node.position for node in source_nodes]
    base_x = max((position.x for position in source_positions), default=80) + 300
    base_y = min((position.y for position in source_positions), default=80)

    temp_to_real: dict[str, str] = {}
    planned_nodes: list[CanvasNode] = []
    for index, item in enumerate(raw_nodes[:12]):
        if not isinstance(item, dict):
            continue
        temp_id = str(item.get("tempId") or item.get("id") or f"n{index + 1}")
        node_id = f"node-{uuid.uuid4()}"
        temp_to_real[temp_id] = node_id
        node_type = _node_type(item.get("type"), workflow)
        title = str(item.get("title") or f"Planned {node_type.replace('_', ' ')}")
        body = "" if node_type in {"paragraph", "review"} else str(item.get("body") or "")
        raw_tags = item.get("tags", [])
        tags = [str(tag) for tag in raw_tags if isinstance(tag, str)] if isinstance(raw_tags, list) else []
        tags = list(dict.fromkeys([*tags, "draft", "ai"]))

        planned_nodes.append(
            CanvasNode(
                id=node_id,
                type=node_type,
                title=title,
                body=body,
                position=Point(x=base_x + index * 260, y=base_y),
                size=Size(width=220, height=150),
                metadata=NodeMetadata(
                    createdAt=timestamp,
                    updatedAt=timestamp,
                    sourceNodeIds=source_node_ids,
                    generatedByWorkflow=workflow,
                    generatedPlanId=plan_id,
                    tags=tags,
                ),
                outlineLevel=None,
                targetWordCount=None,
                narrativeTask=None,
                childNodeIds=[],
            )
        )

    character_source_ids = {node.id for node in source_nodes if node.type == "character"}
    valid_node_ids = (set(source_node_ids) - character_source_ids) | set(temp_to_real.values())
    planned_edges: list[CanvasEdge] = []
    for item in raw_edges[:24]:
        if not isinstance(item, dict):
            continue
        raw_source = str(item.get("source") or item.get("sourceNodeId") or "")
        raw_target = str(item.get("target") or item.get("targetNodeId") or "")
        source_id = temp_to_real.get(raw_source, raw_source)
        target_id = temp_to_real.get(raw_target, raw_target)
        if source_id not in valid_node_ids or target_id not in valid_node_ids or source_id == target_id:
            continue

        semantic = _edge_semantic(item.get("semantic"), workflow)
        planned_edges.append(
            CanvasEdge(
                id=f"edge-{uuid.uuid4()}",
                sourceNodeId=source_id,
                targetNodeId=target_id,
                semantic=semantic,
                label=str(item.get("label") or semantic),
                metadata=EdgeMetadata(
                    createdAt=timestamp,
                    updatedAt=timestamp,
                    sourceNodeIds=source_node_ids,
                    generatedByWorkflow=workflow,
                    generatedPlanId=plan_id,
                    tags=["draft", "ai"],
                ),
            )
        )

    if not planned_nodes:
        raise StructurePlanError("The model returned no usable planned nodes.")

    try:
        return AIGenerationPlan(
            id=plan_id,
            workflow=workflow,
            sourceNodeIds=source_node_ids,
            plannedNodes=planned_nodes,
            plannedEdges=planned_edges,
            createdAt=timestamp,
        )
    except ValidationError as exc:
        raise StructurePlanError(f"Generated plan failed schema validation: {exc}") from exc


async def generate_structure_plan(workflow: StructureWorkflow, source_node_ids: list[str]) -> AIGenerationPlan:
    project = read_project()
    model_id = project.settings.modelRouting.structureDerivationModelId
    if not model_id:
        raise StructurePlanError("No structure derivation model is selected in project settings.")

    registered_model = find_registered_model(model_id)
    if registered_model is None:
        raise StructurePlanError(f"Structure derivation model is not registered: {model_id}")

    provider = find_provider(registered_model.providerId)
    if provider is None:
        raise StructurePlanError(f"Provider is not registered: {registered_model.providerId}")

    node_by_id = {node.id: node for node in project.nodes}
    trigger_nodes = [node_by_id[node_id] for node_id in source_node_ids if node_id in node_by_id]
    if not trigger_nodes:
        raise StructurePlanError("Select at least one existing source node.")
    upsert_character_nodes_as_worldbook_entries(trigger_nodes)
    source_nodes = [node for node in trigger_nodes if node.type != "character"]

    try:
        response_text = await create_chat_completion(
            provider,
            registered_model.modelId,
            _prompt(workflow, source_nodes, trigger_nodes),
            max_tokens=2500,
        )
    except ProviderRequestError as exc:
        raise StructurePlanError(str(exc)) from exc

    payload = _extract_json_object(response_text)
    return _build_plan(workflow, [node.id for node in source_nodes], source_nodes, payload)
