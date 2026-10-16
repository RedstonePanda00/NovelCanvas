from __future__ import annotations

import re
from typing import Literal

from .models import CanvasNode, ProjectFile, WorldbookEntry


KEY_SPLIT_PATTERN = re.compile(r"[,，、;；\r\n]+")


def worldbook_usage_contract(task: Literal["prose", "structure", "review", "discussion"]) -> str:
    """Shared distinction between world facts and instructions to narrate them."""
    common = (
        "\nWORLDBOOK USE CONTRACT:\n"
        "Triggered entries are a reference library of world facts, not a writing checklist or a style sample. "
        "A keyword match only makes an entry available; it does not make every fact relevant. "
        "Use facts individually, according to the current task and scene. "
        "Keep relevant facts consistent even when they remain unstated. Omission is not contradiction. "
        "Distinguish a fact that constrains an action from a fact the reader needs to be told now. "
        "Do not invent an observation, comparison, gesture, flashback, or plot beat merely to display a supplied fact. "
        "A character's name or reappearance does not request a portrait, biography, personality summary, or recitation of beliefs. "
        "Apply the same distinction to character/reference nodes and recalled prose, not only worldbook blocks. "
    )
    if task == "discussion":
        return common + "Discuss the author's design goals and explain alternatives. Distinguish existing facts from proposed changes. Follow the requested response format.\n"
    if task == "prose":
        return common + (
            "Let the current action, conflict, dialogue, and viewpoint determine what is expressed. "
            "Express a reference detail when the author explicitly requests it or it serves a concrete purpose here "
            "(for example identification, a changed condition, physical causality, or a meaningful viewpoint response). "
            "Otherwise let it constrain the writing silently. This is not a blanket ban on description. "
            "Do not repeatedly decorate entrances, turns of the head, or dialogue with unchanged eye color, "
            "hair, scales, horns, clothing, or other signature features. Rephrasing the same portrait is still repetition. "
            "Treat details already stated in Current body or prior-prose references as established; repeat only for a new narrative purpose. "
            "Do not assume a character introduction is needed just because this target node is empty. "
            "For example, a known hand injury can affect how a character opens a bottle without retelling the injury; "
            "an explicit request for a portrait should still receive an accurate portrait. "
            "Before returning prose, remove reference-driven exposition that does not serve this task. "
            "Return only the requested prose, without a fact-selection list or explanation.\n"
        )
    if task == "structure":
        return common + (
            "Derive beats from the author's source goals and causal progression. "
            "Do not promote incidental reference details into mandatory scene beats or paragraph handoff requirements. "
            "Include a world fact as an explicit constraint only when the planned action depends on it. "
            "Do not add character-introduction or appearance-description beats on every scene entrance. "
            "Preserve explicitly requested descriptions and existing source beats; do not erase them under an anti-repetition rule. "
            "Return only the requested structure in its required format, without a fact-selection report.\n"
        )
    return common + (
        "Evaluate contradictions and unnecessary repeated exposition separately. "
        "Do not report an omitted appearance, backstory, or belief as an error merely because it is in the worldbook. "
        "Flag repetition only with evidence in the provided prose; do not claim earlier chapters repeated something without seeing them. "
        "When a description is explicitly requested or serves the action, do not penalize it for using worldbook facts. "
        "Return only an actionable review supported by the supplied text.\n"
    )


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


def collect_worldbook_entries(
    project: ProjectFile,
    target: CanvasNode,
    context_nodes: list[CanvasNode],
) -> list[WorldbookEntry]:
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
        content = _truncate_by_token_budget(entry.content, entry.tokenBudget)
        # Keys, priorities and source-node tags control retrieval, not narrative emphasis.
        parts.append(f"Reference entry: {entry.title}\nFacts (use selectively; may remain unstated):\n{content}".strip())

    return "\n\n---\n\n".join(parts)
