"""Bounded parallel workers on isolated snapshots; coordinator owns the merge."""
import asyncio
import copy
import json

from pydantic import BaseModel, ConfigDict, Field

class WorkerTask(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    task: str = Field(min_length=1, max_length=6000)
    nodeIds: list[str] = Field(default_factory=list, max_length=100)


class DelegationArguments(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    tasks: list[WorkerTask] = Field(min_length=1, max_length=2)


DELEGATE_TOOL = {
    "name": "delegate_parallel",
    "description": "Delegate 1–2 independent tasks to concurrent agents. Each has the same reading tools and its own context and working copy. Give a precise task and disjoint writable nodeIds; [] means read-only research/review. Workers may patch/rename assigned nodes; creation, deletion, relationships and canon changes remain with you. Workers cannot delegate. Results and staged edits return together; YOU must reread every merged change, check cross-task consistency, and complete targets. Call plan_work before delegating edits. Choose this only when parallel work benefits the task; answer simple questions directly. A failed batch merges nothing. Workers are bounded to 32 calls and 10 minutes; split large tasks into further batches.",
    "parameters": DelegationArguments.model_json_schema(),
}


def merge_workers(workspace, snapshot, results):
    """Validate on a copy, then replace state once. Never partially merge a batch."""
    candidate = copy.deepcopy(workspace)
    base = {node.id: node for node in snapshot.nodes}
    changed = []
    for result in results:
        for node_id, token, ranges in result["state"]["reads"]:
            candidate.read_ranges.setdefault((node_id, token), []).extend(ranges)
        candidate.lore_reads.update(result["state"]["loreReads"])
        for edit in result["response"]["edits"]:
            node_id = edit["targetNodeId"]
            if edit["operation"] != "replace" or node_id not in result["allowed"]:
                raise ValueError("Worker returned an edit outside its assignment.")
            current = candidate.nodes.get(node_id)
            original = base[node_id]
            if current is None or current.body != original.body or current.title != original.title:
                raise ValueError("Worker merge conflict; no worker edits were merged.")
            current.body, current.title = edit["body"], edit["title"]
            candidate.verified.pop(node_id, None)
            # Main agent must read the merged text itself; child reads are evidence only.
            candidate.read_ranges = {key: ranges for key, ranges in candidate.read_ranges.items() if key[0] != node_id}
            candidate.work_items[node_id] = {"status": "pending", "finding": ""}
            changed.append(node_id)
        if result["response"].get("mutations"):
            raise ValueError("Workers cannot change project structure or worldbook.")
    workspace.restore(candidate.checkpoint())
    return {"workers": [{"task": r["task"], "reply": r["response"]["reply"],
                         "blocks": r["response"].get("blocks", []),
                         "coverage": r["response"]["coverage"]} for r in results],
            "changedNodeIds": changed, "requiresCoordinatorReview": bool(changed)}


async def delegate_events(workspace, request, provider, model, arguments, step):
    from .project_agent import project_agent_events

    tasks = DelegationArguments.model_validate(arguments).tasks
    claimed = set()
    for task in tasks:
        ids = set(task.nodeIds)
        if len(ids) != len(task.nodeIds) or not ids <= workspace.nodes.keys() or claimed & ids:
            raise ValueError("Worker writable nodes must exist and be disjoint; merge related tasks or delegate read-only review.")
        claimed.update(ids)
    if claimed and (not workspace.allow_writes or not workspace.plan_declared):
        raise ValueError("Writable delegation requires an editing request and plan_work first.")
    snapshot = workspace.project.model_copy(deep=True)
    queue = asyncio.Queue()

    async def run(index, assignment):
        child = request.model_copy(update={"project": snapshot.model_copy(deep=True), "checkpoint": None,
            "history": [], "targetNodeId": "", "targetNodeIds": assignment.nodeIds,
            "message": json.dumps({"authorRequest": request.message, "assignment": assignment.task,
                                   "writableNodeIds": assignment.nodeIds}, ensure_ascii=False),
            "action": "agent" if assignment.nodeIds else "discuss"})
        state = None
        from .agent_checkpoint import merge_checkpoint
        async def consume():
            nonlocal state
            async for event in project_agent_events(child, provider, model, worker_node_ids=set(assignment.nodeIds)):
                if event["type"] == "checkpoint":
                    state = merge_checkpoint(state, event["checkpoint"])
                elif event["type"] == "activity":
                    await queue.put({"type": "activity", "step": step, "tool": "delegate_parallel",
                        "title": f"{index + 1} · {assignment.task[:100]}",
                        "message": f"{event['step']} · {event['tool']} · {event.get('message', '')}",
                        "changedCount": workspace.changes()["total"],
                        "planned": workspace.work_status()["total"], "completed": workspace.work_status()["completed"]})
                elif event["type"] == "done":
                    return {"task": assignment.task, "allowed": set(assignment.nodeIds),
                            "response": event["response"], "state": state["workspace"]}
            raise ValueError("Worker ended without a final result.")
        return await asyncio.wait_for(consume(), timeout=600)

    running = [asyncio.create_task(run(i, task)) for i, task in enumerate(tasks)]
    group = asyncio.gather(*running, return_exceptions=True)
    try:
        while not group.done():
            try:
                yield await asyncio.wait_for(queue.get(), timeout=0.2)
            except asyncio.TimeoutError:
                pass
        while not queue.empty():
            yield queue.get_nowait()
        results = await group
        errors = [r for r in results if isinstance(r, BaseException)]
        if errors:
            raise ValueError("Parallel batch failed; no worker changes merged. Retry a smaller task or handle it directly. " + type(errors[0]).__name__)
        yield {"type": "delegation_result", "result": merge_workers(workspace, snapshot, results)}
    finally:
        for task in running:
            task.cancel()
        await asyncio.gather(*running, return_exceptions=True)
