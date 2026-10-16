"""Request-local manuscript tools. No tool writes the on-disk project.

The agent works against a snapshot; the client must compare baseBody before
committing each final change. Reads after a patch see the patched text.
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from uuid import uuid4

from .models import CanvasNode, NodeMetadata, Point, ProjectFile, Size
from .worldbook import collect_worldbook_entries
from .agent_mutations import AgentMutationTools


def revision(body: str) -> str:
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


class AgentWorkspace(AgentMutationTools):
    def __init__(self, project: ProjectFile):
        self.project = project.model_copy(deep=True)
        self.nodes = {node.id: node for node in self.project.nodes}
        self.original = {node.id: node.body or "" for node in project.nodes}
        self.original_titles = {node.id: node.title for node in project.nodes}
        self.created: dict[str, str] = {}
        self.searches: dict[str, list[str]] = {}
        self.search_pages: dict[str, list[list[int]]] = {}
        self.read_ranges: dict[tuple[str, str], list[list[int]]] = {}
        self.verified: dict[str, str] = {}
        self.work_items: dict[str, dict] = {}
        self.init_mutations(project)
        self.allow_writes = True
        self.require_plan = False
        self.plan_declared = False
        self.write_node_ids: set[str] | None = None

    def execute(self, name: str, args: dict) -> dict:
        from .agent_tools import MUTATING, invoke
        mutating = name in MUTATING
        if mutating and self.write_node_ids is not None and (name not in {"patch_node", "rename_node"} or args.get("nodeId") not in self.write_node_ids):
            raise ValueError("Worker may only patch or rename its assigned writable nodes. Ask the coordinator for other changes.")
        if not self.allow_writes and mutating:
            raise ValueError("This is a read-only discussion request; manuscript changes are disabled.")
        if self.require_plan and mutating and not self.plan_declared:
            raise ValueError("Call plan_work before making changes. Use query/nodeType for whole-book tasks or nodeIds for specific targets; use nodeIds=[] for creation-only or worldbook-only work.")
        if not isinstance(args, dict):
            raise ValueError("Tool arguments must be an object.")
        result = invoke(self, name, args)
        if self.require_plan and mutating:
            ids = [args.get("nodeId")] if name in {"patch_node", "rename_node", "delete_node"} else [result.get("id")] if name == "create_node" else [args.get("sourceNodeId"), args.get("targetNodeId")] if name == "set_relationship" else []
            for node_id in ids:
                if node_id:
                    self.work_items[node_id] = {"status": "completed" if name == "delete_node" else "pending", "finding": "Deleted as requested" if name == "delete_node" else ""}
        return result

    def plan_work(self, query: str = "", nodeType: str | None = None, nodeIds: list[str] | None = None) -> dict:
        if not isinstance(query, str):
            raise ValueError("Query must be a string.")
        if nodeIds is not None and (not isinstance(nodeIds, list) or any(node_id not in self.nodes for node_id in nodeIds)):
            raise ValueError("Explicit worklist nodes must exist.")
        self.plan_declared = True
        needle = query.casefold()
        for node in self.nodes.values():
            if (node.id in nodeIds if nodeIds is not None else (not nodeType or node.type == nodeType) and (needle in node.title.casefold() or needle in (node.body or "").casefold())):
                self.work_items.setdefault(node.id, {"status": "pending", "finding": ""})
        return self.work_status()

    def work_status(self, limit: int = 10) -> dict:
        if not isinstance(limit, int) or not 1 <= limit <= 100:
            raise ValueError("Worklist limit must be 1–100.")
        pending = [node_id for node_id, item in self.work_items.items() if item["status"] != "completed"]
        return {"total": len(self.work_items), "completed": len(self.work_items) - len(pending),
                "nextAction": ("All planned targets are complete. If the request is satisfied, call finish_task with your answer now (or return reply and done=true). Only continue tools for a specific unresolved issue."
                               if self.work_items and not pending else "Choose the next tool needed for the request."),
                "remaining": len(pending), "next": [{"id": node_id, "title": self.nodes[node_id].title,
                    "currentTextRead": self.verified.get(node_id) == revision(self.nodes[node_id].body or ""),
                    "nextAction": "After reviewing the current text, call complete_target(nodeId, finding); rereading alone does not complete a target."}
                    for node_id in pending[:limit]]}

    def complete_target(self, nodeId: str, finding: str) -> dict:
        if nodeId not in self.work_items:
            raise ValueError("Target is not in the worklist.")
        if not isinstance(finding, str) or not finding.strip() or len(finding) > 2000:
            raise ValueError("Give a concise finding: what was changed or why no change was needed.")
        if self.verified.get(nodeId) != revision(self.nodes[nodeId].body or ""):
            raise ValueError("Read the full current node before completing its review.")
        self.work_items[nodeId] = {"status": "completed", "finding": finding}
        return self.work_status()

    def search_worldbook(self, query: str = "", offset: int = 0, limit: int = 30) -> dict:
        if not isinstance(query, str) or not isinstance(offset, int) or offset < 0 or not isinstance(limit, int) or not 1 <= limit <= 100:
            raise ValueError("Invalid worldbook search arguments.")
        entries = [e for e in self.project.worldbook.entries if e.enabled and
                   query.casefold() in (e.title + " " + " ".join(e.keys) + " " + e.content).casefold()]
        return {"total": len(entries), "items": [{"id": e.id, "title": e.title, "keys": e.keys}
                for e in entries[offset:offset + limit]],
                "nextOffset": offset + limit if offset + limit < len(entries) else None}

    def read_worldbook(self, entryId: str, offset: int = 0, limit: int = 12000) -> dict:
        entry = next((e for e in self.project.worldbook.entries if e.id == entryId and e.enabled), None)
        if entry is None:
            raise ValueError("Enabled worldbook entry does not exist.")
        if not isinstance(offset, int) or not 0 <= offset <= len(entry.content) or not isinstance(limit, int) or not 1 <= limit <= 20000:
            raise ValueError("Invalid worldbook read range.")
        end = min(len(entry.content), offset + limit)
        ranges = self.read_ranges.setdefault(("worldbook:" + entryId, revision(entry.content)), [])
        ranges.append([offset, end])
        covered = 0
        for start, stop in sorted(ranges):
            if start > covered:
                break
            covered = max(covered, stop)
        if covered == len(entry.content):
            self.lore_reads[entryId] = entry.content
        return {"id": entry.id, "title": entry.title, "content": entry.content[offset:end],
                "nextOffset": end if end < len(entry.content) else None}

    def list_relationships(self, nodeId: str, offset: int = 0, limit: int = 20) -> dict:
        if nodeId not in self.nodes or not isinstance(offset, int) or offset < 0 or not isinstance(limit, int) or not 1 <= limit <= 100:
            raise ValueError("Invalid relationship page.")
        edges = [e for e in self.project.edges if e.sourceNodeId == nodeId or e.targetNodeId == nodeId]
        return {"total": len(edges), "items": [{"id": e.id, "sourceNodeId": e.sourceNodeId,
                    "targetNodeId": e.targetNodeId, "semantic": e.semantic} for e in edges[offset:offset + limit]],
                "nextOffset": offset + limit if offset + limit < len(edges) else None}

    def matching_worldbook(self, nodeId: str, offset: int = 0, limit: int = 20) -> dict:
        if nodeId not in self.nodes or not isinstance(offset, int) or offset < 0 or not isinstance(limit, int) or not 1 <= limit <= 100:
            raise ValueError("Invalid worldbook match page.")
        entries = collect_worldbook_entries(self.project, self.nodes[nodeId], [])
        return {"total": len(entries), "items": [{"id": e.id, "title": e.title} for e in entries[offset:offset + limit]],
                "nextOffset": offset + limit if offset + limit < len(entries) else None}

    def search(self, query: str = "", nodeType: str | None = None,
               offset: int = 0, limit: int = 30, refresh: bool = False) -> dict:
        if not isinstance(query, str) or not isinstance(offset, int) or offset < 0:
            raise ValueError("Invalid search query or offset.")
        if not isinstance(limit, int) or not 1 <= limit <= 100:
            raise ValueError("Search limit must be 1–100.")
        needle = query.casefold()
        key = json.dumps([needle, nodeType])
        # Freeze result IDs for each query. Editing a hit must not shift subsequent pages.
        if key not in self.searches or refresh or offset == 0:
            self.searches[key] = [n.id for n in self.nodes.values() if (not nodeType or n.type == nodeType)
                                 and (needle in n.title.casefold() or needle in (n.body or "").casefold())]
            self.search_pages[key] = []
        matches = self.searches[key]
        self.search_pages.setdefault(key, []).append([offset, min(len(matches), offset + limit)])
        items = []
        for node_id in matches[offset:offset + limit]:
            if node_id not in self.nodes:
                items.append({"id": node_id, "deleted": True})
                continue
            node = self.nodes[node_id]
            body = node.body or ""
            position = max(0, body.casefold().find(needle))
            items.append({"id": node.id, "title": node.title, "nodeType": node.type,
                          "length": len(body), "excerpt": body[max(0, position - 80):position + 240]})
        return {"total": len(matches), "items": items,
                "nextOffset": offset + limit if offset + limit < len(matches) else None}

    def read(self, nodeId: str, offset: int = 0, limit: int = 12000) -> dict:
        if nodeId not in self.nodes:
            raise ValueError("Node does not exist.")
        if not isinstance(offset, int) or offset < 0 or not isinstance(limit, int) or not 1 <= limit <= 20000:
            raise ValueError("Read offset must be nonnegative; limit must be 1–20000.")
        node = self.nodes[nodeId]
        body = node.body or ""
        if offset > len(body):
            raise ValueError("Read offset exceeds body length.")
        end = min(len(body), offset + limit)
        token = revision(body)
        ranges = self.read_ranges.setdefault((nodeId, token), [])
        ranges.append([offset, end])
        covered = 0
        for start, stop in sorted(ranges):
            if start > covered:
                break
            covered = max(covered, stop)
        if covered == len(body):
            self.verified[nodeId] = token
        return {"id": nodeId, "title": node.title, "nodeType": node.type,
                "narrativeTask": node.narrativeTask, "targetWordCount": node.targetWordCount,
                "outlineLevel": node.outlineLevel,
                "body": body[offset:end], "offset": offset, "length": len(body),
                "nextOffset": end if end < len(body) else None, "revision": token,
                "worldbook": self.matching_worldbook(nodeId, limit=10),
                "relationships": self.list_relationships(nodeId, limit=10)}

    def patch(self, nodeId: str, expectedRevision: str, oldText: str, newText: str) -> dict:
        if nodeId not in self.nodes:
            raise ValueError("Node does not exist.")
        node = self.nodes[nodeId]
        body = node.body or ""
        token = revision(body)
        if expectedRevision != token:
            raise ValueError("Stale revision; read the current node again.")
        if not isinstance(oldText, str) or not oldText or not isinstance(newText, str):
            raise ValueError("Supply nonempty exact oldText and string newText.")
        if body.count(oldText) != 1:
            raise ValueError("oldText must match exactly once; include surrounding text.")
        start = body.index(oldText)
        if not any(a <= start and b >= start + len(oldText)
                   for a, b in self.read_ranges.get((nodeId, token), [])):
            raise ValueError("Read the passage before editing it.")
        updated = body.replace(oldText, newText, 1)
        if not updated.strip():
            raise ValueError("A patch cannot erase the entire node.")
        node.body = updated
        self.read_ranges = {key: value for key, value in self.read_ranges.items() if key[0] != nodeId}
        self.verified.pop(nodeId, None)
        if nodeId in self.work_items:
            self.work_items[nodeId] = {"status": "pending", "finding": ""}
        return {"id": nodeId, "revision": revision(updated), "length": len(updated),
                "status": "staged", "requiresVerification": True}

    def create(self, nodeType: str, title: str, body: str, anchorId: str = "",
               referenceNodeIds: list[str] | None = None) -> dict:
        if nodeType not in {"paragraph", "outline", "scene", "character", "supplemental_info", "instruction"}:
            raise ValueError("Unsupported node type.")
        if not isinstance(title, str) or not title.strip() or not isinstance(body, str) or not body.strip():
            raise ValueError("A new node needs a title and body.")
        refs = list(dict.fromkeys(referenceNodeIds or ([anchorId] if anchorId else [])))
        if (anchorId and anchorId not in self.nodes) or any(ref not in self.nodes for ref in refs):
            raise ValueError("Anchor and references must exist.")
        if any(ref not in self.verified for ref in refs):
            raise ValueError("Read the reference nodes in full before creating from them.")
        anchor = self.nodes.get(anchorId)
        timestamp = datetime.now(timezone.utc).isoformat()
        node_id = str(uuid4())
        node = CanvasNode(id=node_id, type=nodeType, title=title, body=body,
                          position=Point(x=anchor.position.x + anchor.size.width + 100 if anchor else 0,
                                         y=anchor.position.y if anchor else len(self.created) * 300),
                          size=Size(width=320, height=260),
                          metadata=NodeMetadata(createdAt=timestamp, updatedAt=timestamp,
                                                sourceNodeIds=refs, tags=["ai", "design"]))
        self.nodes[node_id] = node
        self.project.nodes.append(node)
        self.created[node_id] = anchorId
        return {"id": node_id, "title": title, "revision": revision(body), "status": "staged",
                "requiresVerification": True}

    def rename(self, nodeId: str, expectedTitle: str, title: str) -> dict:
        if nodeId not in self.nodes or not isinstance(title, str) or not title.strip():
            raise ValueError("Node must exist and title must be nonempty.")
        if self.nodes[nodeId].title != expectedTitle:
            raise ValueError("Title changed; read the node again.")
        if nodeId not in self.verified:
            raise ValueError("Read the node in full before renaming it.")
        self.nodes[nodeId].title = title
        self.verified.pop(nodeId, None)
        if nodeId in self.work_items:
            self.work_items[nodeId] = {"status": "pending", "finding": ""}
        return {"id": nodeId, "title": title, "status": "staged", "requiresVerification": True}

    def changed_nodes(self):
        return [n for n in self.nodes.values() if n.id in self.created or
                (n.body or "") != self.original[n.id] or n.title != self.original_titles[n.id]]

    def changes(self) -> dict:
        items = [{"id": n.id, "title": n.title,
                  "verified": self.verified.get(n.id) == revision(n.body or "")}
                 for n in self.changed_nodes()]
        return {"items": items, "total": len(items)}

    def final_edits(self) -> list[dict]:
        if self.require_plan and self.changed_nodes() and (not self.plan_declared or any(n.id not in self.work_items for n in self.changed_nodes())):
            raise ValueError("Declare and complete the changed targets using plan_work before finishing.")
        if self.work_status()["remaining"]:
            raise ValueError("Worklist has unfinished targets. Use work_status and finish them before reporting completion.")
        if any(not item["verified"] for item in self.changes()["items"]):
            raise ValueError("Read every changed node in full after its final patch before finishing.")
        return [{"targetNodeId": self.created[n.id] if n.id in self.created else n.id,
                 "operation": "create" if n.id in self.created else "replace", "nodeType": n.type,
                 "title": n.title, "body": n.body, "baseBody": self.original.get(n.id, ""),
                 "baseTitle": self.original_titles[n.id] if n.id not in self.created and n.title != self.original_titles[n.id] else None,
                 "proposedNodeId": n.id if n.id in self.created else None,
                 "creationSourceNodeIds": n.metadata.sourceNodeIds if n.id in self.created else []}
                for n in self.changed_nodes()]

    def checkpoint(self) -> dict:
        return {"nodes": [n.model_dump() for n in self.changed_nodes()], "created": self.created,
                "reads": [[node_id, token, [list(interval) for interval in ranges]] for (node_id, token), ranges in self.read_ranges.items()],
                "verified": self.verified, "searches": self.searches, "searchPages": self.search_pages,
                "workItems": self.work_items, "plan": {"declared": self.plan_declared}, "edges": {e.id: e.model_dump() for e in self.project.edges},
                "lore": {e.id: e.model_dump() for e in self.project.worldbook.entries},
                "loreReads": self.lore_reads,
                "deleted": {node_id: True for node_id in self.original_nodes if node_id not in self.nodes},
                "nodeLinks": {n.id: {"children": n.childNodeIds, "sources": n.metadata.sourceNodeIds} for n in self.nodes.values()}}

    def restore(self, state: dict) -> None:
        from .models import CanvasEdge, WorldbookEntry
        created = state.get("created", {})
        for item in state.get("nodes", []):
            node = CanvasNode.model_validate(item)
            if node.id not in self.nodes and node.id not in created:
                raise ValueError("Checkpoint references an unknown node.")
            self.nodes[node.id] = node
        for node_id in state.get("deleted", {}):
            self.nodes.pop(node_id, None)
        for node_id, links in state.get("nodeLinks", {}).items():
            if node_id in self.nodes:
                self.nodes[node_id].childNodeIds = links["children"]
                self.nodes[node_id].metadata.sourceNodeIds = links["sources"]
        self.created = created
        self.project.nodes = list(self.nodes.values())
        self.read_ranges = {(node_id, token): [list(interval) for interval in ranges] for node_id, token, ranges in state.get("reads", [])}
        self.verified = state.get("verified", {})
        self.searches = state.get("searches", {})
        self.search_pages = state.get("searchPages", {})
        self.work_items = state.get("workItems", {})
        self.plan_declared = state.get("plan", {}).get("declared", False)
        if "edges" in state:
            self.project.edges = [CanvasEdge.model_validate(e) for e in state["edges"].values()]
        if "lore" in state:
            self.project.worldbook.entries = [WorldbookEntry.model_validate(e) for e in state["lore"].values()]
        self.lore_reads = state.get("loreReads", {})
