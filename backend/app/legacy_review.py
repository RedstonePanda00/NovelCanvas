"""Read-time compatibility for projects made before review moved into chat."""
from __future__ import annotations

from typing import Any


def migrate_review_node(value: Any) -> Any:
    if not isinstance(value, dict) or value.get("type") != "review":
        return value
    metadata = dict(value.get("metadata") or {})
    metadata["tags"] = list(dict.fromkeys([*(metadata.get("tags") or []), "legacy-review"]))
    return {**value, "type": "supplemental_info", "metadata": metadata}
