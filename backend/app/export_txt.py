from __future__ import annotations

from .models import CanvasNode, ProjectFile


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


def _format_manuscript(project: ProjectFile, nodes: list[CanvasNode]) -> str:
    node_by_id = {node.id: node for node in project.nodes}
    descendants: set[str] = set()

    def collect(node: CanvasNode) -> None:
        if node.type != "container":
            return
        for child_id in node.childNodeIds:
            if child_id in descendants:
                continue
            descendants.add(child_id)
            child = node_by_id.get(child_id)
            if child is not None:
                collect(child)

    for node in nodes:
        collect(node)

    emitted: set[str] = set()
    parts: list[str] = []

    def emit(node: CanvasNode) -> None:
        if node.id in emitted:
            return
        emitted.add(node.id)
        if node.type == "paragraph" and node.body:
            parts.append(node.body)
        elif node.type == "container":
            if node.title:
                parts.append(node.title)
            if node.body:
                parts.append(node.body)
            for child_id in node.childNodeIds:
                child = node_by_id.get(child_id)
                if child is not None:
                    emit(child)

    for node in nodes:
        if node.id not in descendants:
            emit(node)

    return "\n\n".join(part.strip() for part in parts if part.strip())


def export_txt(project: ProjectFile, node_ids: list[str], mode: str) -> str:
    nodes = _ordered_nodes(project, node_ids)

    if mode == "manuscript":
        return _format_manuscript(project, nodes)

    return "\n\n---\n\n".join(_format_asset(node) for node in nodes)
