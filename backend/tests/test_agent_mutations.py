
from backend.tests import environment as _test_environment
import json
import unittest

from backend.app.agent_workspace import AgentWorkspace
from backend.app.models import CanvasEdge, WorldbookEntry, ProjectFile
from backend.tests.test_streaming import outline_project


class AgentMutationTests(unittest.TestCase):
    def test_mutations_and_checkpoint_persist_per_conversation_with_only_latest_batch(self):
        project = outline_project().model_dump()
        checkpoint = {"version": 1, "step": 5, "memory": "Continue checking the scene"}
        old = {"id": "old", "kind": "edge", "targetId": "old-edge", "createdAt": "1"}
        latest = {**old, "id": "latest", "createdAt": "2"}
        project["workbench"] = {"__chat__": {"agentRun": {"checkpoint": checkpoint}, "mutations": [old, latest], "versions": [
            {"id": "v", "title": "Old", "body": "x", "baseBody": "y", "nodeType": "scene", "createdAt": "1"}
        ]}}
        work = ProjectFile.model_validate_json(ProjectFile.model_validate(project).model_dump_json()).workbench["__chat__"]
        self.assertEqual([m.id for m in work.mutations], ["latest"])
        self.assertEqual(work.versions, [])
        self.assertEqual(work.agentRun.checkpoint, checkpoint)

    def test_deleting_a_node_preserves_children_and_records_all_reference_cleanup(self):
        project = outline_project()
        parent = project.nodes[0]
        child = parent.model_copy(deep=True, update={"id": "child", "title": "Child"})
        parent.childNodeIds = [child.id]
        child.metadata.sourceNodeIds = [parent.id]
        project.nodes.append(child)
        project.edges = [CanvasEdge(id="edge", sourceNodeId=parent.id, targetNodeId=child.id, semantic="reference")]
        work = AgentWorkspace(project)
        work.read(parent.id)
        work.delete_node(parent.id, parent.title)
        self.assertEqual(list(work.nodes), [child.id])
        self.assertEqual(work.nodes[child.id].metadata.sourceNodeIds, [])
        restored = AgentWorkspace(project)
        restored.restore(json.loads(json.dumps(work.checkpoint())))
        mutations = restored.final_mutations()
        self.assertEqual({m["kind"] for m in mutations}, {"edge", "node_delete", "node_links"})
        self.assertEqual(next(m for m in mutations if m["kind"] == "node_delete")["before"]["childNodeIds"], [child.id])
        self.assertEqual(len(project.nodes), 2)
        self.assertEqual(len(project.edges), 1)

    def test_worldbook_edits_require_read_then_reread_and_preserve_other_facts(self):
        project = outline_project()
        project.worldbook.entries = [WorldbookEntry(id="lore", title="Mira", content="Mira has blue eyes. She is a navigator.", keys=["Mira"])]
        work = AgentWorkspace(project)
        with self.assertRaisesRegex(ValueError, "Read the entire"):
            work.patch_worldbook("lore", "blue", "green")
        work.read_worldbook("lore")
        work.patch_worldbook("lore", "blue", "green")
        with self.assertRaisesRegex(ValueError, "Reread"):
            work.final_mutations()
        work.read_worldbook("lore")
        mutation = work.final_mutations()[0]
        self.assertEqual(mutation["after"]["content"], "Mira has green eyes. She is a navigator.")
        self.assertEqual(mutation["before"]["content"], project.worldbook.entries[0].content)
        self.assertEqual(mutation["after"]["keys"], ["Mira"])

    def test_new_relationship_is_readable_on_the_next_step_and_checkpointed(self):
        project = outline_project()
        project.nodes.append(project.nodes[0].model_copy(update={"id": "second"}))
        work = AgentWorkspace(project)
        work.read("outline")
        with self.assertRaisesRegex(ValueError, "both endpoints"):
            work.set_relationship("outline", "second", "must_follow")
        work.read("second")
        work.set_relationship("outline", "second", "must_follow")
        work.set_relationship("outline", "second", "must_follow")
        self.assertEqual(work.list_relationships("second")["total"], 1)
        restored = AgentWorkspace(project)
        restored.restore(json.loads(json.dumps(work.checkpoint())))
        self.assertEqual(restored.final_mutations()[0]["after"]["semantic"], "must_follow")

