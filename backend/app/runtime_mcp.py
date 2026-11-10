"""Local Streamable HTTP tools for the manuscript currently open in Novel Canvas."""
from datetime import datetime, timezone
from uuid import uuid4

from mcp.server.fastmcp import FastMCP
from pydantic import Field
from typing import Annotated, Any

from .models import CanvasEdge, CanvasNode, EdgeSemantic, NodeMetadata, NodeType, Point, Size
from .stores import project_lock, read_project, write_project

runtime = FastMCP("NovelCanvas", host="127.0.0.1", stateless_http=True, json_response=True,
                  instructions="Search the current manuscript, then read relevant nodes and worldbook entries. "
                               "Writes commit immediately. Pass the revision from your read. On conflict reread before retrying.")
Offset = Annotated[int, Field(ge=0)]
PageSize = Annotated[int, Field(ge=1, le=100)]
TextSize = Annotated[int, Field(ge=1, le=20000)]
Title = Annotated[str, Field(min_length=1)]


def page(items, offset, limit):
    end = offset + limit
    return {"items": items[offset:end], "total": len(items), "nextOffset": end if end < len(items) else None}


def find_node(project, node_id):
    for node in project.nodes:
        if node.id == node_id:
            return node
    raise ValueError("Unknown node ID")


def for_edit(revision):
    project = read_project()
    if revision != project.updatedAt:
        raise ValueError("The project changed. Read the latest manuscript before retrying.")
    return project


@runtime.tool()
def search_nodes(query: str = "", node_type: NodeType | None = None, offset: Offset = 0, limit: PageSize = 30) -> dict[str, Any]:
    """Find nodes by title or body. An empty query lists the manuscript."""
    project = read_project()
    needle = query.casefold()
    hits = [{"id": n.id, "title": n.title, "type": n.type} for n in project.nodes
            if (node_type is None or node_type == n.type)
            and (needle in n.title.casefold() or needle in (n.body or "").casefold())]
    return {"project": project.title, "revision": project.updatedAt, **page(hits, offset, limit)}


@runtime.tool()
def read_node(node_id: str, offset: Offset = 0, limit: TextSize = 12000) -> dict[str, Any]:
    """Read a page of a node's manuscript text, metadata and ordered children."""
    project = read_project()
    node = find_node(project, node_id)
    body = node.body or ""
    end = offset + limit
    return {**node.model_dump(exclude={"body", "image"}), "imageFileName": node.image.fileName if node.image else None, "body": body[offset:end],
            "nextOffset": end if end < len(body) else None, "revision": project.updatedAt}


@runtime.tool()
def list_relationships(node_id: str, offset: Offset = 0, limit: PageSize = 30) -> dict[str, Any]:
    """List incoming and outgoing semantic edges for a node."""
    project = read_project()
    find_node(project, node_id)
    edges = [e.model_dump() for e in project.edges if node_id in (e.sourceNodeId, e.targetNodeId)]
    return {"revision": project.updatedAt, **page(edges, offset, limit)}


@runtime.tool()
def search_worldbook(query: str = "", offset: Offset = 0, limit: PageSize = 30) -> dict[str, Any]:
    """Find enabled lore entries by title, keyword or content."""
    project = read_project()
    entries = [{"id": e.id, "title": e.title, "keys": e.keys} for e in project.worldbook.entries
               if e.enabled and query.casefold() in " ".join([e.title, *e.keys, e.content]).casefold()]
    return {"revision": project.updatedAt, **page(entries, offset, limit)}


@runtime.tool()
def read_worldbook(entry_id: str, offset: Offset = 0, limit: TextSize = 12000) -> dict[str, Any]:
    """Read an enabled worldbook entry by ID."""
    project = read_project()
    for entry in project.worldbook.entries:
        if entry.id == entry_id and entry.enabled:
            end = offset + limit
            return {**entry.model_dump(exclude={"content"}), "content": entry.content[offset:end],
                    "nextOffset": end if end < len(entry.content) else None, "revision": project.updatedAt}
    raise ValueError("Unknown enabled worldbook entry")


@runtime.tool()
def create_node(revision: str, node_type: NodeType, title: Title, body: str = "") -> dict[str, Any]:
    """Add a manuscript node at the right of the canvas and return its ID."""
    with project_lock:
        project = for_edit(revision)
        now = datetime.now(timezone.utc).isoformat()
        x = max((n.position.x + n.size.width + 60 for n in project.nodes), default=0)
        node = CanvasNode(id=str(uuid4()), type=node_type, title=title, body=body,
                          position=Point(x=x, y=0), size=Size(width=320, height=260),
                          metadata=NodeMetadata(createdAt=now, updatedAt=now))
        project = project.model_copy(update={"nodes": [*project.nodes, node]})
        return {"id": node.id, "revision": write_project(project).updatedAt}


@runtime.tool()
def patch_node(revision: str, node_id: str, old_text: str, new_text: str) -> dict[str, Any]:
    """Replace one exact, unique passage. For an empty node supply an empty old_text."""
    with project_lock:
        project = for_edit(revision)
        node = find_node(project, node_id)
        body = node.body or ""
        if (body and not old_text) or body.count(old_text) != 1:
            raise ValueError("old_text must match exactly once. Include surrounding text.")
        metadata = node.metadata.model_copy(update={"updatedAt": datetime.now(timezone.utc).isoformat()})
        changed = node.model_copy(update={"body": body.replace(old_text, new_text, 1), "metadata": metadata})
        project = project.model_copy(update={"nodes": [changed if n is node else n for n in project.nodes]})
        return {"id": node.id, "revision": write_project(project).updatedAt}


@runtime.tool()
def connect_nodes(revision: str, source_id: str, target_id: str, semantic: EdgeSemantic = "reference") -> dict[str, Any]:
    """Connect a source node to a distinct target with a directed semantic edge."""
    with project_lock:
        project = for_edit(revision)
        find_node(project, source_id)
        find_node(project, target_id)
        if source_id == target_id:
            raise ValueError("Select two different nodes")
        for edge in project.edges:
            if (edge.sourceNodeId, edge.targetNodeId, edge.semantic) == (source_id, target_id, semantic):
                return {"id": edge.id, "revision": project.updatedAt}
        edge = CanvasEdge(id=str(uuid4()), sourceNodeId=source_id, targetNodeId=target_id,
                          semantic=semantic, label=semantic)
        project = project.model_copy(update={"edges": [*project.edges, edge]})
        return {"id": edge.id, "revision": write_project(project).updatedAt}
