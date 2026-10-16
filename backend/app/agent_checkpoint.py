"""Incremental checkpoint transport, keeping long manuscript runs linear in traffic."""
from __future__ import annotations


def indexed_workspace(workspace: dict) -> dict:
    return {**workspace, "nodes": {n["id"]: n for n in workspace["nodes"]},
            "reads": {read[0]: read for read in workspace["reads"]}}


def workspace_delta(before: dict, after: dict) -> dict:
    left, right = indexed_workspace(before), indexed_workspace(after)
    return {field: {key: right[field].get(key) for key in left.get(field, {}).keys() | right[field].keys()
                    if left.get(field, {}).get(key) != right[field].get(key)} for field in right}


def merge_checkpoint(previous: dict | None, update: dict) -> dict:
    if "workspaceDelta" not in update:
        return update
    if previous is None or update["baseStep"] != previous["step"]:
        raise ValueError("Checkpoint sequence was interrupted.")
    workspace = indexed_workspace(previous["workspace"])
    for field, changes in update["workspaceDelta"].items():
        workspace[field] = dict(workspace.get(field, {}))
        for key, value in changes.items():
            if value is None:
                workspace[field].pop(key, None)
            else:
                workspace[field][key] = value
    workspace["nodes"] = list(workspace["nodes"].values())
    workspace["reads"] = list(workspace["reads"].values())
    return {**{k: v for k, v in update.items() if k not in {"workspaceDelta", "baseStep"}}, "workspace": workspace}
