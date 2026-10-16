from backend.tests import environment as _test_environment
import asyncio
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from backend.app.agent_delegation import delegate_events, merge_workers
from backend.app.agent_tools import definitions
from backend.app.agent_workspace import AgentWorkspace
from backend.app.assistant_workbench import AssistantRequest
from backend.app.project_agent import project_agent_events
from backend.tests.test_streaming import outline_project


class DelegationTests(unittest.TestCase):
    def test_repeated_unchanged_reads_prompt_recovery_instead_of_looping(self):
        calls = 0
        async def model(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls <= 3:
                yield json.dumps({"tool": {"name": "read_node", "arguments": {"nodeId": "outline"}}})
            else:
                self.assertIn("identical read/search", args[2][-1]["content"])
                yield json.dumps({"tool": {"name": "finish_task", "arguments": {"reply": "Reviewed"}}})
        async def run():
            request = AssistantRequest(project=self.workspace().project, targetNodeId="", message="Read the outline")
            with patch("backend.app.project_agent.stream_chat_completion", new=model):
                return [event async for event in project_agent_events(request, None, SimpleNamespace(modelId="test", contextWindowTokens=32000))]
        events = asyncio.run(run())
        self.assertEqual(events[-1]["type"], "done")
        self.assertEqual(calls, 4)

    def test_normal_chat_streams_final_tool_reply_without_edits_or_delegation(self):
        async def model(*args, **kwargs):
            for chunk in ['{"tool":{"name":"finish_task","arguments":{"reply":"A ', 'useful answer"}}}']:
                yield chunk
        async def run():
            request = AssistantRequest(project=self.workspace().project, targetNodeId="", message="Discuss an idea")
            with patch("backend.app.project_agent.stream_chat_completion", new=model):
                return [event async for event in project_agent_events(request, None, SimpleNamespace(modelId="test", contextWindowTokens=32000))]
        events = asyncio.run(run())
        self.assertTrue(any(e["type"] == "preview" and e["reply"] == "A " for e in events))
        self.assertEqual(events[-1]["response"]["reply"], "A useful answer")
        self.assertEqual(events[-1]["response"]["edits"], [])

    def test_coordinator_uses_delegation_then_reviews_and_finishes(self):
        counters = {}
        async def model(*args, **kwargs):
            messages = args[2]
            worker = "You are a bounded worker." in messages[0]["content"]
            task = json.loads(next(m["content"] for m in messages if m["role"] == "user"))
            key = json.loads(task["request"])["writableNodeIds"][0] if worker else "main"
            step = counters[key] = counters.get(key, 0) + 1
            if worker:
                token = json.loads(messages[-1]["content"])["toolResult"]["revision"] if step == 3 else ""
                calls = {
                    1: ("plan_work", {"nodeIds": [key]}),
                    2: ("read_node", {"nodeId": key}),
                    3: ("patch_node", {"nodeId": key, "expectedRevision": token, "oldText": "negotiation", "newText": "meeting"}),
                    4: ("read_node", {"nodeId": key}),
                    5: ("complete_target", {"nodeId": key, "finding": "Verified"}),
                }
            else:
                calls = {
                    1: ("plan_work", {}),
                    2: ("delegate_parallel", {"tasks": [{"task": "Revise", "nodeIds": ["outline"]}, {"task": "Revise", "nodeIds": ["second"]}]}),
                    3: ("read_node", {"nodeId": "outline"}),
                    4: ("complete_target", {"nodeId": "outline", "finding": "Coordinator verified"}),
                    5: ("read_node", {"nodeId": "second"}),
                    6: ("complete_target", {"nodeId": "second", "finding": "Coordinator verified"}),
                }
            if step not in calls:
                yield json.dumps({"tool": {"name": "finish_task", "arguments": {"reply": "Done"}}})
            else:
                name, arguments = calls[step]
                yield json.dumps({"reply": "Working", "tool": {"name": name, "arguments": arguments}})
        async def run():
            request = AssistantRequest(project=self.workspace().project, targetNodeId="", message="Revise both", action="agent")
            with patch("backend.app.project_agent.stream_chat_completion", new=model):
                return [event async for event in project_agent_events(request, None, SimpleNamespace(modelId="test", contextWindowTokens=32000))]
        events = asyncio.run(run())
        self.assertEqual(events[-1]["type"], "done")
        self.assertEqual(len(events[-1]["response"]["edits"]), 2)
        self.assertEqual(events[-1]["response"]["coverage"]["completed"], 2)
        self.assertEqual(set(counters), {"main", "outline", "second"})

    def workspace(self):
        project = outline_project()
        project.nodes.append(project.nodes[0].model_copy(update={"id": "second"}))
        work = AgentWorkspace(project)
        work.require_plan = True
        work.plan_work()
        return work

    def test_registry_schemas_and_scope_are_enforced(self):
        work = self.workspace()
        schema = next(t for t in definitions(work) if t["name"] == "patch_node")
        self.assertIn("expectedRevision", schema["parameters"]["required"])
        self.assertTrue(schema["description"])
        with self.assertRaises(ValueError):
            work.execute("search_nodes", {"limit": "2"})
        with self.assertRaises(ValueError):
            work.execute("read_node", {"nodeId": "outline", "invented": True})
        work.write_node_ids = {"outline"}
        with self.assertRaisesRegex(ValueError, "assigned"):
            work.execute("rename_node", {"nodeId": "second", "title": "No", "expectedTitle": "No"})
        self.assertNotIn("delete_node", [t["name"] for t in definitions(work)])

    def test_rereading_shared_reference_after_merge_and_resume(self):
        work = self.workspace()
        work.read("second")
        child = AgentWorkspace(work.project)
        child.read("second")
        result = {"allowed": set(), "task": "Review reference", "state": json.loads(json.dumps(child.checkpoint())),
                  "response": {"reply": "Checked", "edits": [], "mutations": [], "coverage": {}}}
        merge_workers(work, work.project.model_copy(deep=True), [result])
        work.read("second")
        restored = self.workspace()
        restored.restore(json.loads(json.dumps(work.checkpoint())))
        restored.read("second")
        restored.complete_target("second", "Reference checked after resume")

    def test_parallel_workers_merge_then_require_coordinator_review(self):
        async def run():
            work = self.workspace()
            original = work.project.model_dump()
            started = set()
            both_started = asyncio.Event()

            async def worker(request, provider, model, *, worker_node_ids):
                node_id = next(iter(worker_node_ids))
                started.add(node_id)
                if len(started) == 2:
                    both_started.set()
                await asyncio.wait_for(both_started.wait(), 1)
                child = AgentWorkspace(request.project)
                child.plan_work(nodeIds=[node_id])
                read = child.read(node_id)
                child.patch(node_id, read["revision"], "negotiation", "meeting")
                child.read(node_id)
                child.complete_target(node_id, "Verified")
                yield {"type": "checkpoint", "checkpoint": {"workspace": child.checkpoint(), "step": 1}}
                yield {"type": "activity", "step": 1, "tool": "patch_node"}
                yield {"type": "done", "response": {"reply": "Done", "edits": child.final_edits(),
                       "mutations": [], "coverage": {"planned": 1, "completed": 1}}}

            request = AssistantRequest(project=work.project.model_copy(deep=True), targetNodeId="", message="Revise both", action="agent")
            with patch("backend.app.project_agent.project_agent_events", new=worker):
                events = [event async for event in delegate_events(work, request, object(), object(),
                    {"tasks": [{"task": "Revise first", "nodeIds": ["outline"]},
                               {"task": "Revise second", "nodeIds": ["second"]}]}, 5)]
            self.assertEqual(len([e for e in events if e["type"] == "activity"]), 2)
            self.assertEqual(set(events[-1]["result"]["changedNodeIds"]), {"outline", "second"})
            self.assertEqual(request.project.model_dump(), original)
            for node_id in started:
                self.assertIn("meeting", work.nodes[node_id].body)
                with self.assertRaisesRegex(ValueError, "full current"):
                    work.complete_target(node_id, "Trust worker")
                work.read(node_id)
                work.complete_target(node_id, "Coordinator checked")
            self.assertEqual(len(work.final_edits()), 2)
            restored = AgentWorkspace(request.project)
            restored.restore(json.loads(json.dumps(work.checkpoint())))
            self.assertEqual(len(restored.final_edits()), 2)
        asyncio.run(run())

    def test_overlap_and_failed_worker_do_not_merge(self):
        async def run():
            work = self.workspace()
            before = json.dumps(work.checkpoint())
            request = AssistantRequest(project=work.project, targetNodeId="", message="Revise", action="agent")
            with self.assertRaisesRegex(ValueError, "disjoint"):
                async for _ in delegate_events(work, request, None, None,
                    {"tasks": [{"task": "a", "nodeIds": ["outline"]}, {"task": "b", "nodeIds": ["outline"]}]}, 1):
                    pass
            async def failed(*args, **kwargs):
                raise RuntimeError("provider failed")
                yield
            with patch("backend.app.project_agent.project_agent_events", new=failed):
                with self.assertRaisesRegex(ValueError, "no worker changes"):
                    async for _ in delegate_events(work, request, None, None, {"tasks": [{"task": "a", "nodeIds": ["outline"]}]}, 1):
                        pass
            self.assertEqual(json.dumps(work.checkpoint()), before)
        asyncio.run(run())

    def test_later_merge_conflict_does_not_apply_earlier_worker(self):
        work = self.workspace()
        snapshot = work.project.model_copy(deep=True)
        results = []
        for node_id in ("outline", "second"):
            child = AgentWorkspace(snapshot)
            read = child.read(node_id)
            child.patch(node_id, read["revision"], "negotiation", "meeting")
            child.read(node_id)
            results.append({"allowed": {node_id}, "task": "Revise", "state": child.checkpoint(),
                            "response": {"edits": child.final_edits(), "mutations": []}})
        work.nodes["second"].body = "Changed since delegation."
        before = work.project.model_dump()
        with self.assertRaisesRegex(ValueError, "merge conflict"):
            merge_workers(work, snapshot, results)
        self.assertEqual(work.project.model_dump(), before)

    def test_cancel_stops_all_children_without_merging(self):
        async def run():
            work = self.workspace()
            request = AssistantRequest(project=work.project, targetNodeId="", message="Review")
            started, stopped = set(), set()
            ready = asyncio.Event()
            async def waiting(request, *args, **kwargs):
                task = json.loads(request.message)["assignment"]
                started.add(task)
                if len(started) == 2:
                    ready.set()
                try:
                    await asyncio.Event().wait()
                    yield
                finally:
                    stopped.add(task)
            async def consume():
                async for _ in delegate_events(work, request, None, None, {"tasks": [{"task": "a"}, {"task": "b"}]}, 1):
                    pass
            with patch("backend.app.project_agent.project_agent_events", new=waiting):
                task = asyncio.create_task(consume())
                await asyncio.wait_for(ready.wait(), 1)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
            self.assertEqual(stopped, {"a", "b"})
        asyncio.run(run())
