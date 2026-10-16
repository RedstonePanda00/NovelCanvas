from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timezone
from typing import Any

from pydantic import ValidationError

from .ai_provider import ProviderRequestError, create_chat_completion
from .context_assembly import NODE_CONTEXT_ROLE
from .generation_common import language_contract, resolve_routed_model
from .model_prompts import apply_model_global_prompt
from .models import (
    AIGenerationPlan,
    CanvasEdge,
    CanvasNode,
    EdgeMetadata,
    EdgeSemantic,
    NodeMetadata,
    NodeType,
    Point,
    ProjectFile,
    Size,
    StructureWorkflow,
)
from .worldbook import collect_worldbook_entries, format_worldbook_context, worldbook_usage_contract


class StructurePlanError(RuntimeError):
    pass


ALLOWED_NODE_TYPES: set[str] = {
    "paragraph",
    "outline",
    "scene",
    "character",
    "supplemental_info",
}

ALLOWED_EDGE_SEMANTICS: set[str] = {
    "must_follow",
    "instruction",
    "reference",
    "can_rewrite",
    "style_reference",
}

WORKFLOW_DEFAULT_TYPE: dict[StructureWorkflow, NodeType] = {
    "generate-outline": "outline",
    "generate-scenes": "scene",
    "generate-paragraph-tasks": "paragraph",
    "generate-next-scene": "scene",
    "split-scene": "scene",
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


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


def _node_type(value: Any, workflow: StructureWorkflow) -> NodeType | None:
    if isinstance(value, str):
        if value in ALLOWED_NODE_TYPES:
            return value  # type: ignore[return-value]
        return None
    return WORKFLOW_DEFAULT_TYPE[workflow]


def _edge_semantic(value: Any, workflow: StructureWorkflow) -> EdgeSemantic:
    if isinstance(value, str) and value in ALLOWED_EDGE_SEMANTICS:
        return value  # type: ignore[return-value]
    return "reference"


def _workflow_instructions(workflow: StructureWorkflow, desired_count: int | None = None) -> str:
    count_sentence = ""
    if desired_count is not None:
        count_sentence = f" Create exactly {desired_count} planned node(s) unless the source is too small to divide coherently."
    if workflow == "generate-outline":
        return (
            "Create outline nodes derived from the selected source assets. Use type outline. "
            "Outline node bodies must be structured outline notes only: hierarchy, beats, causality, constraints, and unresolved questions. "
            "Do not write paragraph prose, narration, or dialogue."
        )
    if workflow == "generate-scenes":
        return (
            "Create scene nodes derived from the selected outline node and optional reference assets. Use type scene only. "
            "Scene node bodies must be concrete scene briefs: scene purpose, conflict, ordered beats, participating characters, setting continuity, "
            "entry state, exit state, and paragraph handoff. Do not create outline, paragraph, instruction, character, or supplemental nodes. "
            f"Do not write final prose paragraphs.{count_sentence}"
        )
    if workflow == "generate-next-scene":
        return (
            "Create the next scene node after the selected scene. Use type scene only. "
            "Base it on the selected scene's exit state, unresolved hooks, and optional reference assets. "
            "The body must be a concrete scene brief with purpose, conflict, ordered beats, continuity, entry state, exit state, and paragraph handoff. "
            "Do not create outline, paragraph, instruction, character, or supplemental nodes. Do not write final prose paragraphs. "
            "Create exactly 1 planned scene node."
        )
    if workflow == "split-scene":
        return (
            "Split the selected large scene into 2-6 smaller scene nodes. Use type scene for every planned node. "
            "Each smaller scene must cover one coherent beat or sub-scene from the original scene, preserving order, causality, character state, and continuity. "
            "Scene node bodies must be scene plans, not final prose paragraphs. "
            "Return only the new smaller scene nodes; do not recreate the original scene."
        )
    if workflow == "generate-paragraph-tasks":
        return (
            "Create exactly one executable paragraph placeholder node from the selected scene. Use type paragraph only. "
            "The paragraph node body must be empty. Do not create instruction nodes. "
            "Connect the selected scene to the paragraph with a reference edge so paragraph generation strictly follows the scene brief."
        )
    raise StructurePlanError(f"Unsupported workflow: {workflow}")


def _source_context(source_nodes: list[CanvasNode]) -> str:
    parts: list[str] = []
    for node in source_nodes:
        role = NODE_CONTEXT_ROLE.get(node.type, "REFERENCE")
        parts.append(
            "\n".join(
                [
                    f"ROLE: {role}",
                    f"ID: {node.id}",
                    f"TYPE: {node.type}",
                    f"TITLE: {node.title}",
                    f"TAGS: {', '.join(node.metadata.tags)}",
                    f"BODY:\n{node.body or ''}",
                ]
            )
        )
    return "\n\n---\n\n".join(parts)


def _prompt(
    project: ProjectFile,
    workflow: StructureWorkflow,
    source_nodes: list[CanvasNode],
    trigger_nodes: list[CanvasNode],
    desired_count: int | None = None,
) -> list[dict[str, str]]:
    target_for_scan = source_nodes[0] if source_nodes else trigger_nodes[0]
    worldbook_entries = collect_worldbook_entries(project, target_for_scan, trigger_nodes)
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
                "You may only create a pending plan from the provided source nodes and relevant triggered worldbook entries. "
                f"{worldbook_usage_contract('structure')}"
                "Instruction nodes are user-authored writing directives only; never create instruction nodes. "
                "Do not claim anything as canon. Do not write final prose. "
                f"Return only a JSON object. {language_contract(project)}"
            ),
        },
        {
            "role": "user",
            "content": (
                f"Workflow: {workflow}\n"
                f"{_workflow_instructions(workflow, desired_count)}\n\n"
                "Return this exact JSON shape:\n"
                "{\n"
                '  "nodes": [\n'
                '    {"tempId":"n1","type":"outline|scene|paragraph","title":"...","body":"...","tags":["draft","ai"]}\n'
                "  ],\n"
                '  "edges": [\n'
                '    {"source":"existing source node id or tempId","target":"existing source node id or tempId","semantic":"reference|must_follow|instruction|style_reference|can_rewrite","label":"optional"}\n'
                "  ]\n"
                "}\n\n"
                "Rules:\n"
                "- Use existing source node ids exactly when connecting from provided source nodes.\n"
                "- Character nodes are direct reference sources; do not duplicate them as planned nodes.\n"
                "- Use tempId only for planned nodes you create.\n"
                "- Keep paragraph node body empty.\n"
                "- Keep the plan concise for MVP: 1-8 nodes.\n\n"
                "Worldbook usage rule: consult entries only when relevant to the planned nodes. "
                "Do not include worldbook details merely because they are present.\n\n"
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
    desired_count: int | None = None,
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
    if workflow == "generate-scenes":
        max_nodes = max(1, min(desired_count or 12, 12))
    elif workflow in {"generate-next-scene", "generate-paragraph-tasks"}:
        max_nodes = 1
    else:
        max_nodes = 12
    for index, item in enumerate(raw_nodes[:max_nodes]):
        if not isinstance(item, dict):
            continue
        temp_id = str(item.get("tempId") or item.get("id") or f"n{index + 1}")
        node_id = f"node-{uuid.uuid4()}"
        temp_to_real[temp_id] = node_id
        node_type = _node_type(item.get("type"), workflow)
        if node_type is None:
            continue
        title = str(item.get("title") or f"Planned {node_type.replace('_', ' ')}")
        body = "" if node_type == "paragraph" else str(item.get("body") or "")
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

    if workflow in {"generate-scenes", "generate-next-scene", "split-scene"}:
        planned_nodes = [node for node in planned_nodes if node.type == "scene"]
    elif workflow == "generate-paragraph-tasks":
        planned_nodes = [node for node in planned_nodes if node.type == "paragraph"]

    if workflow == "generate-next-scene":
        planned_nodes = planned_nodes[:1]
    if workflow == "generate-paragraph-tasks":
        planned_nodes = planned_nodes[:1]

    allowed_planned_ids = {node.id for node in planned_nodes}
    final_valid_node_ids = (set(source_node_ids) - character_source_ids) | allowed_planned_ids
    planned_edges = [
        edge
        for edge in planned_edges
        if edge.sourceNodeId in final_valid_node_ids
        and edge.targetNodeId in final_valid_node_ids
        and edge.sourceNodeId != edge.targetNodeId
        and (edge.sourceNodeId in allowed_planned_ids or edge.targetNodeId in allowed_planned_ids)
    ]

    if workflow == "split-scene":
        if len(planned_nodes) < 2:
            raise StructurePlanError("Split scene must return at least two scene nodes.")

        planned_edges = [
            edge
            for edge in planned_edges
            if edge.sourceNodeId in {node.id for node in planned_nodes}
            and edge.targetNodeId in {node.id for node in planned_nodes}
            and edge.sourceNodeId != edge.targetNodeId
        ]

        existing_pairs = {(edge.sourceNodeId, edge.targetNodeId) for edge in planned_edges}
        for source_node, target_node in zip(planned_nodes, planned_nodes[1:]):
            if (source_node.id, target_node.id) in existing_pairs:
                continue
            planned_edges.append(
                CanvasEdge(
                    id=f"edge-{uuid.uuid4()}",
                    sourceNodeId=source_node.id,
                    targetNodeId=target_node.id,
                    semantic="reference",
                    label="reference",
                    metadata=EdgeMetadata(
                        createdAt=timestamp,
                        updatedAt=timestamp,
                        sourceNodeIds=source_node_ids,
                        generatedByWorkflow=workflow,
                        generatedPlanId=plan_id,
                        tags=["draft", "ai", "split-scene"],
                    ),
                )
            )
    elif workflow in {"generate-scenes", "generate-next-scene", "generate-paragraph-tasks"}:
        existing_targets = {edge.targetNodeId for edge in planned_edges if edge.sourceNodeId in source_node_ids}
        primary_source_id = source_node_ids[0] if source_node_ids else ""
        if primary_source_id:
            for node in planned_nodes:
                if node.id in existing_targets:
                    continue
                planned_edges.append(
                    CanvasEdge(
                        id=f"edge-{uuid.uuid4()}",
                        sourceNodeId=primary_source_id,
                        targetNodeId=node.id,
                        semantic="reference",
                        label="reference",
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
        raise StructurePlanError("The model returned no usable planned nodes for this workflow.")

    try:
        return AIGenerationPlan(
            id=plan_id,
            workflow=workflow,
            sourceNodeIds=source_node_ids,
            plannedNodes=planned_nodes,
            plannedEdges=planned_edges,
            createdAt=timestamp,
            replacedNodeIds=source_node_ids if workflow == "split-scene" else [],
        )
    except ValidationError as exc:
        raise StructurePlanError(f"Generated plan failed schema validation: {exc}") from exc


async def generate_structure_plan(
    project: ProjectFile,
    workflow: StructureWorkflow,
    source_node_ids: list[str],
    desired_count: int | None = None,
) -> AIGenerationPlan:
    try:
        routed = resolve_routed_model(project, "structureDerivationModelId", "structure derivation")
    except ValueError as exc:
        raise StructurePlanError(str(exc)) from exc

    node_by_id = {node.id: node for node in project.nodes}
    trigger_nodes = [node_by_id[node_id] for node_id in source_node_ids if node_id in node_by_id]
    if not trigger_nodes:
        raise StructurePlanError("Select at least one existing source node.")
    if workflow == "split-scene":
        if len(trigger_nodes) != 1 or trigger_nodes[0].type != "scene":
            raise StructurePlanError("Split scene requires exactly one selected scene node.")
    if workflow == "generate-next-scene":
        if len(trigger_nodes) != 1 or trigger_nodes[0].type != "scene":
            raise StructurePlanError("Next scene generation requires exactly one selected scene node.")
    if workflow == "generate-scenes":
        if not any(node.type == "outline" for node in trigger_nodes):
            raise StructurePlanError("Scene generation requires an outline source node.")
        if desired_count is not None:
            desired_count = max(1, min(desired_count, 12))
    if workflow == "generate-paragraph-tasks":
        if len(trigger_nodes) != 1 or trigger_nodes[0].type != "scene":
            raise StructurePlanError("Paragraph task generation requires exactly one selected scene node.")
    source_nodes = trigger_nodes

    try:
        response_text = await create_chat_completion(
            routed.provider,
            routed.registered.modelId,
            apply_model_global_prompt(
                _prompt(project, workflow, source_nodes, trigger_nodes, desired_count),
                project,
                "structureDerivationModelId",
                routed.registered.id,
            ),
            max_tokens=2500,
        )
    except ProviderRequestError as exc:
        raise StructurePlanError(str(exc)) from exc

    payload = _extract_json_object(response_text)
    return _build_plan(workflow, [node.id for node in source_nodes], source_nodes, payload, desired_count)
