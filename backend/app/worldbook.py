from __future__ import annotations

import re

from .models import CanvasNode, WorldbookEntry
from .stores import read_project, write_project


KEY_SPLIT_PATTERN = re.compile(r"[,，、;；\r\n]+")


def character_node_worldbook_entry_id(node_id: str) -> str:
    return f"worldbook-character-node-{node_id}"


def character_node_to_worldbook_entry(node: CanvasNode) -> WorldbookEntry:
    tags = list(dict.fromkeys(["character", "source-node", f"source-node:{node.id}", *node.metadata.tags]))
    keys = list(dict.fromkeys([node.title]))
    return WorldbookEntry(
        id=character_node_worldbook_entry_id(node.id),
        title=node.title or "Unnamed Character",
        content=node.body or f"Character: {node.title}",
        keys=[key for key in keys if key.strip()],
        tags=tags,
        enabled=True,
        alwaysOn=False,
        priority=50,
        tokenBudget=None,
        insertionPosition="before_context",
    )


def upsert_character_nodes_as_worldbook_entries(nodes: list[CanvasNode]) -> None:
    character_nodes = [node for node in nodes if node.type == "character"]
    if not character_nodes:
        return

    project = read_project()
    entries_by_id = {entry.id: entry for entry in project.worldbook.entries}
    changed = False
    for node in character_nodes:
        entry = character_node_to_worldbook_entry(node)
        if entries_by_id.get(entry.id) != entry:
            entries_by_id[entry.id] = entry
            changed = True

    if not changed:
        return

    existing_order = [entry.id for entry in project.worldbook.entries]
    new_ids = [character_node_worldbook_entry_id(node.id) for node in character_nodes]
    ordered_ids = [*existing_order, *(entry_id for entry_id in new_ids if entry_id not in existing_order)]
    project.worldbook.entries = [entries_by_id[entry_id] for entry_id in ordered_ids if entry_id in entries_by_id]
    write_project(project)


def _node_scan_text(node: CanvasNode) -> str:
    return "\n".join(
        [
            node.title,
            node.type,
            " ".join(node.metadata.tags),
            node.body or "",
        ]
    ).lower()


def _truncate_by_token_budget(content: str, token_budget: int | None) -> str:
    if not token_budget or token_budget <= 0:
        return content
    max_chars = max(1, token_budget * 4)
    if len(content) <= max_chars:
        return content
    return content[:max_chars].rstrip() + "\n[Worldbook entry truncated by token budget.]"


def _matches_entry(entry: WorldbookEntry, scan_text: str) -> bool:
    if entry.alwaysOn:
        return True

    needles = [
        part.strip()
        for key in entry.keys
        for part in KEY_SPLIT_PATTERN.split(key)
        if part.strip()
    ]
    return any(needle.strip() and needle.strip().lower() in scan_text for needle in needles)


def collect_worldbook_entries(target: CanvasNode, context_nodes: list[CanvasNode]) -> list[WorldbookEntry]:
    project = read_project()
    scan_text = "\n".join(_node_scan_text(node) for node in [target, *context_nodes])
    entries = [
        entry
        for entry in project.worldbook.entries
        if entry.enabled and _matches_entry(entry, scan_text)
    ]
    return sorted(entries, key=lambda entry: (-entry.priority, entry.title.lower(), entry.id))


def format_worldbook_context(entries: list[WorldbookEntry], insertion_position: str | None = None) -> str:
    filtered_entries = [
        entry
        for entry in entries
        if insertion_position is None or entry.insertionPosition == insertion_position
    ]
    if not filtered_entries:
        return "No triggered worldbook entries."

    parts: list[str] = []
    for entry in filtered_entries:
        tags = f"Tags: {', '.join(entry.tags)}\n" if entry.tags else ""
        keys = f"Keys: {', '.join(entry.keys)}\n" if entry.keys else ""
        content = _truncate_by_token_budget(entry.content, entry.tokenBudget)
        parts.append(f"Title: {entry.title}\n{tags}{keys}Priority: {entry.priority}\nContent:\n{content}".strip())

    return "\n\n---\n\n".join(parts)
