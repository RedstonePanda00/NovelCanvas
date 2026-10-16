"""Run a bounded real-provider agent check on synthetic data; never save a project."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.app.assistant_stream import stream_assistant
from backend.app.assistant_workbench import AssistantRequest
from backend.app.models import CanvasEdge, CanvasNode, NodeMetadata, Point, ProjectFile, Size


async def check():
    parallel = "--parallel" in sys.argv
    repeated = "他有银白色长发。"
    nodes = [CanvasNode(id=f"p{i}", type="paragraph", title=f"测试正文 {i}",
                        body=repeated + f"奥维森走向第{i + 1}座城门。", position=Point(x=i * 400, y=0),
                        size=Size(width=300, height=200), metadata=NodeMetadata(createdAt="test", updatedAt="test"))
             for i in range(3)]
    nodes.append(CanvasNode(id="character", type="character", title="奥维森", body="奥维森有银白色长发。这是角色事实，不要求每次出场描写。",
                            position=Point(x=0, y=400), size=Size(width=300, height=200),
                            metadata=NodeMetadata(createdAt="test", updatedAt="test")))
    project = ProjectFile(title="Isolated agent smoke test", nodes=nodes,
                          edges=[CanvasEdge(id=f"e{i}", sourceNodeId="character", targetNodeId=f"p{i}", semantic="reference") for i in range(3)])
    request = AssistantRequest(project=project, scope="project", targetNodeId="", action="agent",
        message="检查全书所有正文节点，删除每处完全相同的重复外貌句‘他有银白色长发。’，其余正文逐字保留。不要修改角色资料节点或连线。请自动定位并完成修改和复查。")
    if parallel:
        request.message += "请调用 delegate_parallel，让两个子代理分别修改 p0 和 p1、p2，主代理负责合并后的逐项复查。"
    response = stream_assistant(request)
    previews = 0
    tools = set()
    async for line in response.body_iterator:
        event = json.loads(line)
        if parallel and event["type"] == "checkpoint":
            recent = event["checkpoint"].get("recent", [])
            if recent:
                latest = json.loads(recent[-1]["content"])
                if "toolError" in latest:
                    print("Tool correction: " + latest["toolError"][:300], flush=True)
        if event["type"] == "preview":
            previews += 1
        if event["type"] == "activity":
            tools.add(event["tool"])
            print(f"Step {event['step']}: {event['tool']}", flush=True)
            if parallel:
                print(f"  Progress: {event.get('completed', 0)}/{event.get('planned', 0)}; staged: {event.get('changedCount', 0)}", flush=True)
            if event["step"] >= 32:
                raise RuntimeError("Smoke test step limit reached.")
        if event["type"] == "error":
            message = event["error"].get("message", "")
            status = re.search(r"HTTP \d{3}", message)
            category = "connection" if "connect" in message.lower() else "tool protocol" if "repeatedly failed" in message else "context budget" if "context" in message.lower() else "provider or protocol"
            raise RuntimeError("Agent returned an error" + (f" ({status.group()})" if status else f" ({category})") + ".")
        if event["type"] == "done":
            result = event["response"]
            edits = {edit["targetNodeId"]: edit for edit in result["edits"]}
            assert set(edits) == {"p0", "p1", "p2"}, "Expected exactly three paragraph edits."
            for index in range(3):
                assert edits[f"p{index}"]["body"] == f"奥维森走向第{index + 1}座城门。", "Unrequested prose change."
            assert not result.get("mutations"), "Unexpected graph or worldbook modification."
            expected = {"plan_work", "read_node", "complete_target", "delegate_parallel" if parallel else "patch_node"}
            assert expected <= tools, "Expected an actual iterative workflow."
            assert previews > 0, "Expected streaming previews."
            assert result["coverage"]["completed"] == result["coverage"]["planned"], "Unfinished worklist."
            print(json.dumps({"passed": True, "edits": len(edits), "previews": previews,
                              "coverage": result["coverage"], "projectSaved": False}), flush=True)
            return
    raise RuntimeError("Stream ended without completion.")


if __name__ == "__main__":
    try:
        asyncio.run(asyncio.wait_for(check(), timeout=600 if "--parallel" in sys.argv else 180))
    except Exception as exc:
        # Never print provider response bodies or config, which can echo credentials.
        print(f"Live agent check failed: {type(exc).__name__}" + (f": {exc}" if isinstance(exc, (AssertionError, RuntimeError)) else ""), flush=True)
        raise SystemExit(1)
