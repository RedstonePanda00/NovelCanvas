
from backend.tests import environment as _test_environment
import asyncio
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from backend.app.agent_workspace import AgentWorkspace
from backend.app.agent_checkpoint import merge_checkpoint, workspace_delta
from backend.app.assistant_workbench import AssistantRequest
from backend.app.project_agent import project_agent_events
from backend.tests.test_streaming import outline_project


class ProjectAgentTests(unittest.TestCase):
    def test_runtime_requires_plan_and_tracks_changed_targets_after_restore(self):
        project = outline_project()
        work = AgentWorkspace(project)
        work.require_plan = True
        read = work.read("outline")
        arguments = {"nodeId": "outline", "expectedRevision": read["revision"],
                     "oldText": "negotiation", "newText": "meeting"}
        with self.assertRaisesRegex(ValueError, "plan_work"):
            work.execute("patch_node", arguments)
        work.execute("plan_work", {"nodeIds": []})
        work.execute("patch_node", arguments)
        restored = AgentWorkspace(project)
        restored.require_plan = True
        restored.restore(json.loads(json.dumps(work.checkpoint())))
        self.assertTrue(restored.plan_declared)
        self.assertEqual(restored.work_status()["remaining"], 1)
        with self.assertRaisesRegex(ValueError, "unfinished"):
            restored.final_edits()
        restored.read("outline")
        restored.complete_target("outline", "Checked revised text.")
        self.assertEqual(len(restored.final_edits()), 1)

    def test_thousand_target_worklist_finishes_every_node_and_checkpoint_delta_stays_small(self):
        project = outline_project()
        project.nodes = [project.nodes[0].model_copy(update={"id": str(i), "body": "Old portrait. Keep the action."}) for i in range(1001)]
        work = AgentWorkspace(project)
        self.assertEqual(work.plan_work()["remaining"], 1001)
        before_last = None
        for index in range(1001):
            if index == 1000:
                before_last = json.loads(json.dumps(work.checkpoint()))
            node_id = str(index)
            read = work.read(node_id)
            work.patch(node_id, read["revision"], "Old portrait. ", "")
            work.read(node_id)
            work.complete_target(node_id, "Removed the repeated portrait; action preserved.")
        self.assertEqual(work.work_status()["remaining"], 0)
        self.assertEqual(len(work.final_edits()), 1001)
        self.assertTrue(all(edit["body"] == "Keep the action." for edit in work.final_edits()))
        delta = workspace_delta(before_last, work.checkpoint())
        self.assertEqual(list(delta["nodes"]), ["1000"])
        self.assertLess(len(json.dumps(delta)), len(json.dumps(work.checkpoint())) // 20)
        self.assertTrue(all(node.body.startswith("Old portrait") for node in project.nodes))

    def test_worklist_prevents_early_completion_and_survives_checkpoint_roundtrip(self):
        project = outline_project()
        work = AgentWorkspace(project)
        self.assertEqual(work.plan_work()["remaining"], 1)
        with self.assertRaisesRegex(ValueError, "unfinished"):
            work.final_edits()
        with self.assertRaisesRegex(ValueError, "full current"):
            work.complete_target("outline", "No change needed")
        read = work.read("outline")
        work.complete_target("outline", "No change needed")
        self.assertEqual(work.final_edits(), [])
        work.patch("outline", read["revision"], "negotiation", "meeting")
        self.assertEqual(work.work_status()["remaining"], 1)
        restored = AgentWorkspace(project)
        restored.restore(json.loads(json.dumps(work.checkpoint())))
        self.assertEqual(restored.work_status()["remaining"], 1)
        restored.read("outline")
        restored.complete_target("outline", "Updated as requested and checked the promise")
        self.assertEqual(len(restored.final_edits()), 1)

    def test_search_does_not_skip_hits_removed_by_an_earlier_page(self):
        project = outline_project()
        project.nodes = [project.nodes[0].model_copy(update={"id": str(i), "body": "old name"}) for i in range(4)]
        work = AgentWorkspace(project)
        first = work.search("old", limit=2)
        for item in first["items"]:
            node = work.read(item["id"])
            work.patch(item["id"], node["revision"], "old", "new")
        second = work.search("old", offset=first["nextOffset"], limit=2)
        self.assertEqual([n["id"] for n in second["items"]], ["2", "3"])
        self.assertEqual(work.search("old")["total"], 2)

    def test_creation_can_be_read_patched_and_used_for_followup_creation(self):
        project = outline_project()
        project.nodes = []
        work = AgentWorkspace(project)
        first = work.create("character", "Mira", "A cautious navigator.")
        read = work.read(first["id"])
        work.patch(first["id"], read["revision"], "cautious", "reckless")
        work.read(first["id"])
        second = work.create("scene", "Departure", "Mira risks the crossing.", anchorId=first["id"])
        work.read(second["id"])
        restored = AgentWorkspace(project)
        restored.restore(json.loads(json.dumps(work.checkpoint())))
        edits = restored.final_edits()
        self.assertEqual(len(edits), 2)
        self.assertEqual(edits[0]["body"], "A reckless navigator.")
        self.assertEqual(edits[1]["targetNodeId"], edits[0]["proposedNodeId"])
        self.assertEqual(edits[1]["creationSourceNodeIds"], [edits[0]["proposedNodeId"]])

    def test_checkpoint_resumes_after_provider_failure_and_rejects_changed_manuscript(self):
        request = AssistantRequest(project=outline_project(), targetNodeId="", scope="project", message="Read the outline")
        calls = 0
        checkpoints = []

        async def interrupted(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise RuntimeError("connection lost")
            yield json.dumps({"memory": "Already read outline; now answer", "tool": {"name": "read_node", "arguments": {"nodeId": "outline"}}})

        async def first_run():
            async for event in project_agent_events(request, object(), SimpleNamespace(modelId="test", contextWindowTokens=32000)):
                if event["type"] == "checkpoint":
                    checkpoints.append(merge_checkpoint(checkpoints[-1] if checkpoints else None, json.loads(json.dumps(event["checkpoint"]))))

        with patch("backend.app.project_agent.stream_chat_completion", new=interrupted):
            with self.assertRaisesRegex(RuntimeError, "connection lost"):
                asyncio.run(first_run())
        self.assertEqual(checkpoints[-1]["step"], 1)
        request.checkpoint = checkpoints[-1]

        async def resumed(*args, **kwargs):
            self.assertIn("Already read outline", json.dumps(args[2]))
            self.assertIn("negotiation", json.dumps(args[2]))
            yield json.dumps({"reply": "A negotiation fails.", "done": True})

        async def resume():
            return [event async for event in project_agent_events(request, object(), SimpleNamespace(modelId="test", contextWindowTokens=32000))]

        with patch("backend.app.project_agent.stream_chat_completion", new=resumed):
            self.assertEqual(asyncio.run(resume())[-1]["type"], "done")
            request.project.nodes[0].body = "Author changed the manuscript."
            with self.assertRaisesRegex(ValueError, "Manuscript changed"):
                asyncio.run(resume())

    def test_search_paginates_thousand_nodes_and_does_not_mutate_source(self):
        project = outline_project()
        prototype = project.nodes[0]
        project.nodes = [prototype.model_copy(update={"id": str(i), "body": "奥维森走进房间。"}) for i in range(1100)]
        work = AgentWorkspace(project)
        ids = []
        offset = 0
        while offset is not None:
            page = work.search("奥维森", offset=offset, limit=100)
            ids.extend(n["id"] for n in page["items"])
            offset = page["nextOffset"]
        self.assertEqual(len(set(ids)), 1100)
        read = work.read("900")
        work.patch("900", read["revision"], "走进", "离开")
        self.assertEqual(project.nodes[900].body, "奥维森走进房间。")
        with self.assertRaisesRegex(ValueError, "Read every"):
            work.final_edits()
        work.read("900")
        edits = work.final_edits()
        self.assertEqual(edits[0]["baseBody"], "奥维森走进房间。")
        self.assertEqual(edits[0]["body"], "奥维森离开房间。")

    def test_patch_requires_read_exact_match_and_current_revision(self):
        work = AgentWorkspace(outline_project())
        read = work.read("outline", limit=1)
        with self.assertRaisesRegex(ValueError, "Read the passage"):
            work.patch("outline", read["revision"], "negotiation", "meeting")
        work.read("outline")
        work.patch("outline", read["revision"], "negotiation", "meeting")
        with self.assertRaisesRegex(ValueError, "Stale revision"):
            work.patch("outline", read["revision"], "meeting", "argument")

    def test_model_searches_reads_modifies_verifies_without_attached_targets(self):
        calls = []
        token = None

        async def model(*args, **kwargs):
            nonlocal token
            messages = args[2]
            calls.append(messages)
            step = len(calls)
            if step in (4, 6):
                result = json.loads(messages[-1]["content"])["toolResult"]
                token = result["revision"]
            actions = {
                1: {"name": "search_nodes", "arguments": {"query": "negotiation"}},
                2: {"name": "plan_work", "arguments": {"nodeIds": ["outline"]}},
                3: {"name": "read_node", "arguments": {"nodeId": "outline"}},
                4: {"name": "patch_node", "arguments": {"nodeId": "outline", "expectedRevision": token,
                                                        "oldText": "negotiation", "newText": "meeting"}},
                5: {"name": "read_node", "arguments": {"nodeId": "outline"}},
                6: {"name": "complete_target", "arguments": {"nodeId": "outline", "finding": "Changed the term and checked the promise."}},
            }
            yield json.dumps({"reply": "Done", "done": True} if step == 7 else
                             {"reply": "Working", "memory": "Verify the changed outline", "tool": actions[step]})

        async def run():
            request = AssistantRequest(project=outline_project(), targetNodeId="", scope="project", action="agent", message="全书将 negotiation 改成 meeting")
            return [event async for event in project_agent_events(request, object(), SimpleNamespace(modelId="test", contextWindowTokens=32000))]

        with patch("backend.app.project_agent.stream_chat_completion", new=model):
            events = asyncio.run(run())
        self.assertEqual(len(calls), 7)
        self.assertEqual(events[-1]["type"], "done")
        self.assertEqual(events[-1]["response"]["edits"][0]["body"], "A meeting ends in a failed promise.")
        self.assertEqual(len([e for e in events if e["type"] == "activity"]), 6)


if __name__ == "__main__":
    unittest.main()
