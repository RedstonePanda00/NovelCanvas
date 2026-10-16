"""Graph and worldbook tools with explicit before/after records for atomic commit."""
from __future__ import annotations

from uuid import uuid4

from .models import CanvasEdge, ProjectFile, WorldbookEntry


class AgentMutationTools:
    def init_mutations(self, project):
        self.original_nodes = {n.id: n.model_dump() for n in project.nodes}
        self.original_edges = {e.id: e.model_dump() for e in project.edges}
        self.original_lore = {e.id: e.model_dump() for e in project.worldbook.entries}
        self.lore_reads = {}

    def preconditions(self) -> dict:
        ids = {node_id for node_id, _ in self.read_ranges if node_id in self.original_nodes}
        nodes = []
        for node_id in ids:
            node = self.original_nodes[node_id]
            nodes.append({key: node[key] for key in ("id", "type", "title", "body", "childNodeIds", "narrativeTask", "targetWordCount", "outlineLevel")}
                         | {"sourceNodeIds": node["metadata"]["sourceNodeIds"], "tags": node["metadata"]["tags"]})
        return {"nodes": nodes, "worldbook": [self.original_lore[entry_id] for entry_id in self.lore_reads if entry_id in self.original_lore],
                "edges": [{key: edge[key] for key in ("id", "sourceNodeId", "targetNodeId", "semantic")} for edge in self.original_edges.values()] if ids else None}

    def set_relationship(self, sourceNodeId: str, targetNodeId: str, semantic: str, remove: bool = False) -> dict:
        if sourceNodeId == targetNodeId or sourceNodeId not in self.nodes or targetNodeId not in self.nodes:
            raise ValueError("Relationships require two different existing nodes.")
        if semantic not in {"reference", "must_follow", "instruction", "can_rewrite", "style_reference"}:
            raise ValueError("Unsupported relationship semantic.")
        if any(node_id not in self.verified for node_id in (sourceNodeId, targetNodeId)):
            raise ValueError("Read both endpoints before changing a relationship.")
        matching = [e for e in self.project.edges if e.sourceNodeId == sourceNodeId and e.targetNodeId == targetNodeId and e.semantic == semantic]
        if remove:
            self.project.edges = [e for e in self.project.edges if e not in matching]
        elif not matching:
            self.project.edges.append(CanvasEdge(id=str(uuid4()), sourceNodeId=sourceNodeId, targetNodeId=targetNodeId, semantic=semantic, label=semantic))
        return {"status": "staged", "relationships": self.list_relationships(targetNodeId)}

    def delete_node(self, nodeId: str, expectedTitle: str) -> dict:
        if nodeId not in self.nodes or self.nodes[nodeId].title != expectedTitle:
            raise ValueError("Node or title changed; read it again before deletion.")
        if nodeId not in self.verified:
            raise ValueError("Read the full node before deleting it.")
        del self.nodes[nodeId]
        self.project.nodes = list(self.nodes.values())
        self.project.edges = [e for e in self.project.edges if nodeId not in (e.sourceNodeId, e.targetNodeId)]
        for node in self.nodes.values():
            node.childNodeIds = [item for item in node.childNodeIds if item != nodeId]
            node.metadata.sourceNodeIds = [item for item in node.metadata.sourceNodeIds if item != nodeId]
        # Children remain in the manuscript; deleting a container does not delete its contents.
        for created, anchor in list(self.created.items()):
            if anchor == nodeId:
                self.created[created] = ""
        self.created.pop(nodeId, None)
        self.verified.pop(nodeId, None)
        if nodeId in self.work_items:
            self.work_items[nodeId] = {"status": "completed", "finding": "Deleted as requested"}
        return {"id": nodeId, "status": "staged deletion"}

    def patch_worldbook(self, entryId: str, oldText: str, newText: str) -> dict:
        entry = next((e for e in self.project.worldbook.entries if e.id == entryId and e.enabled), None)
        if entry is None or self.lore_reads.get(entryId) != entry.content:
            raise ValueError("Read the entire current worldbook entry before editing it.")
        if not isinstance(oldText, str) or not oldText or not isinstance(newText, str) or entry.content.count(oldText) != 1:
            raise ValueError("oldText must match exactly once in the worldbook entry.")
        updated = entry.content.replace(oldText, newText, 1)
        if not updated.strip():
            raise ValueError("A worldbook patch cannot erase the entire entry.")
        entry.content = updated
        self.lore_reads.pop(entryId, None)
        return {"id": entryId, "title": entry.title, "status": "staged", "requiresVerification": True}

    def create_worldbook(self, title: str, content: str, keys: list[str]) -> dict:
        if not isinstance(title, str) or not title.strip() or not isinstance(content, str) or not content.strip():
            raise ValueError("A worldbook entry needs a title and facts.")
        entry = WorldbookEntry(id=str(uuid4()), title=title, content=content, keys=keys)
        self.project.worldbook.entries.append(entry)
        return {"id": entry.id, "title": title, "status": "staged", "requiresVerification": True}

    def final_mutations(self) -> list[dict]:
        result = []

        def compare(kind, before, after):
            for item_id in dict.fromkeys([*before, *after]):
                if before.get(item_id) != after.get(item_id):
                    result.append({"kind": kind, "targetId": item_id, "before": before.get(item_id), "after": after.get(item_id),
                                   "index": list(before).index(item_id) if item_id in before else None})

        compare("edge", self.original_edges, {e.id: e.model_dump() for e in self.project.edges})
        lore = {e.id: e.model_dump() for e in self.project.worldbook.entries}
        for item_id, entry in lore.items():
            if entry != self.original_lore.get(item_id) and self.lore_reads.get(item_id) != entry["content"]:
                raise ValueError("Reread modified worldbook entries before finishing.")
        compare("worldbook", self.original_lore, lore)
        for node_id, before in self.original_nodes.items():
            if node_id not in self.nodes:
                result.append({"kind": "node_delete", "targetId": node_id, "before": before, "after": None,
                               "index": list(self.original_nodes).index(node_id)})
                continue
            node = self.nodes[node_id]
            left = {"id": node_id, "childNodeIds": before["childNodeIds"], "sourceNodeIds": before["metadata"]["sourceNodeIds"]}
            right = {"id": node_id, "childNodeIds": node.childNodeIds, "sourceNodeIds": node.metadata.sourceNodeIds}
            if left != right:
                result.append({"kind": "node_links", "targetId": node_id, "before": left, "after": right})
        ProjectFile.model_validate(self.project.model_dump())
        # Reverse rollback restores deletions in original order, including adjacent nodes.
        return [m for m in result if m["after"] is not None] + sorted(
            [m for m in result if m["after"] is None], key=lambda m: m.get("index") or 0, reverse=True)
