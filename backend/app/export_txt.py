from __future__ import annotations

from .models import CanvasNode, ProjectFile
from .stores import read_project


def _ordered_nodes(project: ProjectFile, node_ids: list[str]) -> list[CanvasNode]:
    node_by_id = {node.id: node for node in project.nodes}
    if node_ids:
        return [node_by_id[node_id] for node_id in node_ids if node_id in node_by_id]
    return project.nodes


def _format_asset(node: CanvasNode) -> str:
    tags = ", ".join(node.metadata.tags) if node.metadata.tags else "none"
    source_ids = ", ".join(node.metadata.sourceNodeIds) if node.metadata.sourceNodeIds else "none"
    metadata_lines = [
        f"# {node.title}",
        "",
        f"Type: {node.type}",
        f"ID: {node.id}",
        f"Tags: {tags}",
        f"Created: {node.metadata.createdAt}",
        f"Updated: {node.metadata.updatedAt}",
        f"Generated workflow: {node.metadata.generatedByWorkflow or 'none'}",
        f"Generated plan: {node.metadata.generatedPlanId or 'none'}",
        f"Source nodes: {source_ids}",
        "",
        node.body or "",
    ]
    return "\n".join(metadata_lines).strip()


def _container_manuscript(project: ProjectFile, node: CanvasNode) -> list[str]:
    node_by_id = {item.id: item for item in project.nodes}
    parts: list[str] = []
    if node.title:
        parts.append(node.title)
    if node.body:
        parts.append(node.body)

    for child_id in node.childNodeIds:
        child = node_by_id.get(child_id)
        if child is None:
            continue
        if child.type == "paragraph" and child.body:
            parts.append(child.body)
        elif child.type == "container":
            parts.extend(_container_manuscript(project, child))

    return parts


def _format_manuscript(project: ProjectFile, nodes: list[CanvasNode]) -> str:
    parts: list[str] = []
    for node in nodes:
        if node.type == "paragraph" and node.body:
            parts.append(node.body)
        elif node.type == "container":
            parts.extend(_container_manuscript(project, node))

    return "\n\n".join(part.strip() for part in parts if part.strip())


def export_txt(node_ids: list[str], mode: str) -> str:
    project = read_project()
    nodes = _ordered_nodes(project, node_ids)

    if mode == "manuscript":
        return _format_manuscript(project, nodes)

    return "\n\n---\n\n".join(_format_asset(node) for node in nodes)
