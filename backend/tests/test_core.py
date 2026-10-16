from __future__ import annotations

from backend.tests import environment as _test_environment

import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch



from fastapi.testclient import TestClient  # noqa: E402
from fastapi import HTTPException  # noqa: E402
from pydantic import ValidationError  # noqa: E402

from backend.app.context_preview import build_context_preview  # noqa: E402
from backend.app.export_txt import export_txt  # noqa: E402
from backend.app.main import _ndjson_events, app  # noqa: E402
from backend.app.models import CanvasEdge, CanvasNode, NodeMetadata, Point, ProjectFile, Size  # noqa: E402
from backend.app.rag import preview_rag_for_target, project_memory_fingerprint  # noqa: E402
from backend.app.stores import find_provider  # noqa: E402
from backend.app.models import Worldbook, WorldbookEntry  # noqa: E402
from backend.app import paragraph_generation, node_completion, structure_plans  # noqa: E402
from backend.app.context_assembly import compress_paragraph_reference  # noqa: E402
from backend.app.worldbook import collect_worldbook_entries, format_worldbook_context  # noqa: E402
from backend.app.assistant_workbench import AssistantRequest, build_messages, selected_context, run_assistant  # noqa: E402
from backend.app.models import AIProviderConfig, LocalAppConfig, RegisteredModel  # noqa: E402


def node(node_id: str, node_type: str, title: str, body: str = "") -> CanvasNode:
    return CanvasNode(
        id=node_id,
        type=node_type,
        title=title,
        body=body,
        position=Point(x=0, y=0),
        size=Size(width=320, height=220),
        metadata=NodeMetadata(createdAt="1", updatedAt="1"),
    )


class CoreTests(unittest.TestCase):
    def test_storage_is_isolated_before_import(self) -> None:
        from backend.app.paths import PROJECT_FILE, KNOWLEDGE_BASE_DIR, LOCAL_APP_CONFIG_FILE
        self.assertTrue(PROJECT_FILE.is_relative_to(_test_environment.ROOT))
        self.assertTrue(KNOWLEDGE_BASE_DIR.is_relative_to(_test_environment.ROOT))
        self.assertTrue(LOCAL_APP_CONFIG_FILE.is_relative_to(_test_environment.ROOT))

    def test_export_all_deduplicates_nested_and_shared_paragraphs(self) -> None:
        paragraph = node("p", "paragraph", "P", "Once")
        inner = node("inner", "container", "Inner")
        outer = node("outer", "container", "Outer")
        inner.childNodeIds = [paragraph.id]
        outer.childNodeIds = [inner.id, paragraph.id]
        project = ProjectFile(nodes=[paragraph, inner, outer])
        self.assertEqual(export_txt(project, [], "manuscript"), "Outer\n\nInner\n\nOnce")
        self.assertEqual(export_txt(project, [paragraph.id], "manuscript"), "Once")

    def test_container_cycles_are_rejected(self) -> None:
        left = node("left", "container", "Left")
        right = node("right", "container", "Right")
        left.childNodeIds = [right.id]
        right.childNodeIds = [left.id]
        with self.assertRaises(ValidationError):
            ProjectFile(nodes=[left, right])

    def test_container_manuscript_preserves_child_order(self) -> None:
        chapter = node("chapter", "container", "Chapter One")
        first = node("first", "paragraph", "First", "Alpha")
        second = node("second", "paragraph", "Second", "Beta")
        chapter.childNodeIds = [second.id, first.id]
        project = ProjectFile(nodes=[chapter, first, second])
        self.assertEqual(export_txt(project, [chapter.id], "manuscript"), "Chapter One\n\nBeta\n\nAlpha")

    def test_context_preview_uses_generation_rules(self) -> None:
        source = node("source", "scene", "Source", "Scene brief")
        target = node("target", "paragraph", "Target")
        allowed = CanvasEdge(id="a", sourceNodeId=source.id, targetNodeId=target.id, semantic="reference")
        excluded = CanvasEdge(id="b", sourceNodeId=source.id, targetNodeId=target.id, semantic="review_target")
        preview = build_context_preview(ProjectFile(nodes=[source, target], edges=[excluded, allowed]), target.id)
        self.assertEqual([item.edgeId for item in preview.items], [allowed.id])
        self.assertEqual(preview.excluded[0].reasonCode, "review_semantic")

    def test_memory_fingerprint_changes_with_body(self) -> None:
        paragraph = node("p", "paragraph", "P", "Before")
        project = ProjectFile(nodes=[paragraph])
        before = project_memory_fingerprint(project)
        paragraph.body = "After"
        self.assertNotEqual(before, project_memory_fingerprint(project))

    def test_stale_memory_preview_does_not_call_embedding_provider(self) -> None:
        paragraph = node("stale", "paragraph", "P", "Current text")
        preview = asyncio.run(preview_rag_for_target(ProjectFile(nodes=[paragraph]), paragraph.id, 5))
        self.assertTrue(preview.stale)
        self.assertIn("out of date", preview.unavailableReason or "")

    def test_ndjson_stream_separates_errors_from_text(self) -> None:
        async def chunks():
            yield "draft"
            raise RuntimeError("provider failed")

        async def collect() -> list[dict]:
            return [json.loads(item) async for item in _ndjson_events(chunks())]

        events = asyncio.run(collect())
        self.assertEqual(events[0], {"type": "chunk", "text": "draft"})
        self.assertEqual(events[1]["type"], "error")
        self.assertNotIn("provider failed", events[0]["text"])


class WorldbookPromptTests(unittest.TestCase):
    def setUp(self) -> None:
        self.scene = node("scene", "scene", "Negotiation", "Aster negotiates a price, then leaves.")
        self.target = node("target", "paragraph", "Continuation")
        self.entry = WorldbookEntry(id="lore", title="Aster", keys=["Aster"], tags=["source-node:private-editor-id"],
                                   content="Aster has white scales and violet eyes. His left hand is injured.", priority=50)
        self.project = ProjectFile(nodes=[self.scene, self.target], worldbook=Worldbook(entries=[self.entry]))
        self.edge = CanvasEdge(id="edge", sourceNodeId=self.scene.id, targetNodeId=self.target.id, semantic="reference")

    def test_retrieval_metadata_is_not_presented_as_narrative_priority(self) -> None:
        entries = collect_worldbook_entries(self.project, self.target, [self.scene])
        self.assertEqual([entry.id for entry in entries], ["lore"])
        rendered = format_worldbook_context(entries)
        self.assertIn(self.entry.content, rendered)
        for metadata in ["Priority:", "Keys:", "source-node:private-editor-id"]:
            self.assertNotIn(metadata, rendered)
        self.assertEqual(format_worldbook_context(entries, "before_context"), "No triggered worldbook entries.")

    def test_prose_contract_preserves_facts_and_explicit_tasks_in_both_modes(self) -> None:
        for mode in ["replace", "append"]:
            for task in ["Aster negotiates a price, then leaves.", "Describe Aster's face and scales in a detailed portrait."]:
                with self.subTest(mode=mode, task=task):
                    self.scene.body = task
                    self.target.body = "He entered the room."
                    with patch.object(paragraph_generation, "_format_rag_context", new=AsyncMock(return_value="No memory")):
                        messages = asyncio.run(paragraph_generation._messages(self.project, self.target, [(self.edge, self.scene)], mode))
                    system, user = messages[0]["content"], messages[1]["content"]
                    self.assertIn("Omission is not contradiction", system)
                    self.assertIn("Rephrasing the same portrait is still repetition", system)
                    self.assertIn("author explicitly requests", system)
                    self.assertIn(task, user)
                    self.assertIn(self.entry.content, user)
                    self.assertIn(f"GENERATION MODE: {mode}", user)

    def test_structure_and_outline_do_not_turn_lore_into_mandatory_beats(self) -> None:
        messages = structure_plans._prompt(self.project, "generate-next-scene", [self.scene], [self.scene])
        self.assertIn("Do not promote incidental reference details into mandatory scene beats", messages[0]["content"])
        self.assertIn(self.entry.content, messages[1]["content"])
        outline = node("outline", "outline", "Aster's next step")
        messages = asyncio.run(node_completion._messages(self.project, outline, [(self.edge, self.scene)]))
        self.assertIn("Do not promote incidental reference details into mandatory scene beats", messages[0]["content"])

    def test_chat_reports_are_not_manuscript_edits(self) -> None:
        messages, _ = build_messages(AssistantRequest(project=self.project, targetNodeId=self.scene.id, action="agent", message="Review the scene and produce a report"))
        self.assertIn('"blocks"', messages[0]["content"])
        self.assertIn('return edits=[] unless', messages[0]["content"])

    def test_compression_keeps_action_constraints_without_portrait_templates(self) -> None:
        prior = node("prior", "paragraph", "Previous", "Aster's violet eyes gleamed. His injured hand could not grip the latch.")
        routed = SimpleNamespace(provider=object(), registered=SimpleNamespace(id="model", modelId="model"))
        completion = AsyncMock(return_value="Established: the injured hand cannot grip the latch.")
        with patch("backend.app.context_assembly.resolve_routed_model", return_value=routed), patch("backend.app.context_assembly.create_chat_completion", new=completion):
            result = asyncio.run(compress_paragraph_reference(self.project, prior))
        sent = completion.call_args.args[2]
        self.assertIn("already-established fact", sent[0]["content"])
        self.assertIn("Preserve injuries, disguises", sent[0]["content"])
        self.assertIn(prior.body, sent[1]["content"])
        self.assertIn("injured hand", result)


class AssistantWorkbenchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.target = node("target", "scene", "Negotiation", "Aster negotiates.")
        self.reference = node("ref", "character", "Aster", "Aster is cautious.")
        self.unrelated = node("private", "paragraph", "Unselected", "DO NOT INCLUDE THIS")
        self.project = ProjectFile(nodes=[self.target, self.reference, self.unrelated], worldbook=Worldbook(entries=[WorldbookEntry(id="lore", title="Aster", keys=["Aster"], content="Violet eyes")]))
        self.request = AssistantRequest(project=self.project, targetNodeId="target", referenceNodeIds=["ref"], message="Make the reply shorter", action="revise", baseText="Candidate v1", preserve="Keep the ending")

    def test_scope_is_explicit_and_candidate_is_separate_from_canon(self) -> None:
        messages, context = build_messages(self.request)
        payload = json.loads(messages[-1]["content"])
        self.assertEqual(payload["BASE VERSION"], "Candidate v1")
        self.assertEqual(payload["MUST PRESERVE"], "Keep the ending")
        self.assertEqual([item.id for item in context.nodes], ["target", "ref"])
        self.assertEqual([item.id for item in context.worldbook], ["lore"])
        self.assertNotIn("DO NOT INCLUDE THIS", json.dumps(messages))
        self.assertEqual(self.target.body, "Aster negotiates.")

    def test_excluded_lore_and_missing_references(self) -> None:
        self.request.excludedWorldbookIds = ["lore"]
        self.assertEqual(selected_context(self.request)[2].worldbook, [])
        self.request.referenceNodeIds.append("deleted")
        with self.assertRaises(ValueError):
            selected_context(self.request)

    def test_global_chat_route_and_structured_candidate(self) -> None:
        config = LocalAppConfig(chatModelId="chat", providers=[AIProviderConfig(id="p", name="P", baseUrl="https://example.test/v1", apiKey="test")], registeredModels=[RegisteredModel(id="chat", providerId="p", modelId="chat-model", displayName="Chat", capabilityTags=["text"])])
        completion = AsyncMock(return_value=json.dumps({"reply": "Shortened the dialogue.", "proposal": {"title": "Negotiation", "body": "New candidate"}}))
        with patch("backend.app.assistant_workbench.read_local_app_config", return_value=config), patch("backend.app.assistant_workbench.create_chat_completion", new=completion):
            response = asyncio.run(run_assistant(self.request))
            self.assertEqual(response.proposal.body, "New candidate")
            self.assertEqual(completion.call_args.args[1], "chat-model")
            self.request.action = "discuss"
            response = asyncio.run(run_assistant(self.request))
            self.assertIsNone(response.proposal)
        self.assertEqual(self.project.nodes[0].body, "Aster negotiates.")

    def test_legacy_projects_default_to_empty_workbench(self) -> None:
        self.assertEqual(ProjectFile.model_validate({"title": "Legacy"}).workbench, {})

    def test_review_migration_preserves_graph_and_text_and_removes_route(self) -> None:
        raw_node = self.target.model_dump()
        raw_node.update(type="review", body="Original review text")
        data = {"nodes": [raw_node, self.reference.model_dump()], "edges": [{"id": "old-edge", "sourceNodeId": "ref", "targetNodeId": "target", "semantic": "review_basis"}], "settings": {"modelRouting": {"reviewModelId": "old-model", "paragraphGenerationModelId": "prose"}}}
        project = ProjectFile.model_validate(data)
        self.assertEqual(project.nodes[0].type, "supplemental_info")
        self.assertEqual(project.nodes[0].body, "Original review text")
        self.assertEqual(project.edges[0].semantic, "review_basis")
        self.assertEqual(project.edges[0].targetNodeId, "target")
        self.assertNotIn("reviewModelId", project.settings.modelRouting.model_dump())
        self.assertEqual(project.settings.modelRouting.paragraphGenerationModelId, "prose")
        self.assertEqual(ProjectFile.model_validate(project.model_dump()), project)
        self.assertEqual(data["nodes"][0]["type"], "review")

    def test_report_blocks_validate_and_do_not_require_node_edits(self) -> None:
        config = LocalAppConfig(chatModelId="chat", providers=[AIProviderConfig(id="p", name="P", baseUrl="https://example.test/v1", apiKey="test")], registeredModels=[RegisteredModel(id="chat", providerId="p", modelId="chat-model", displayName="Chat", capabilityTags=["text"])])
        self.request.action = "agent"
        completion = AsyncMock(return_value=json.dumps({"reply": "Here is the report", "blocks": [{"title": "Continuity", "body": "The scene contradicts the earlier promise."}], "edits": []}))
        with patch("backend.app.assistant_workbench.read_local_app_config", return_value=config), patch("backend.app.assistant_workbench.create_chat_completion", new=completion):
            response = asyncio.run(run_assistant(self.request))
            self.assertEqual(response.blocks[0].title, "Continuity")
            self.assertEqual(response.edits, [])
            completion.return_value = json.dumps({"reply": "Report", "blocks": [{"title": " ", "body": "x"}]})
            with self.assertRaises(HTTPException):
                asyncio.run(run_assistant(self.request))

    def test_agent_reads_one_incoming_layer_and_requires_expansion(self) -> None:
        self.project.edges = [CanvasEdge(id="a", sourceNodeId="ref", targetNodeId="target", semantic="reference"), CanvasEdge(id="b", sourceNodeId="private", targetNodeId="ref", semantic="reference")]
        self.request.action = "agent"
        self.request.referenceNodeIds = []
        messages, context = build_messages(self.request)
        self.assertEqual([item.id for item in context.nodes], ["target", "ref"])
        self.assertNotIn("DO NOT INCLUDE THIS", json.dumps(messages))
        self.assertEqual(len(context.relationships), 1)
        self.request.referenceNodeIds = ["private"]
        messages, context = build_messages(self.request)
        self.assertIn("DO NOT INCLUDE THIS", json.dumps(messages))
        self.assertEqual(json.loads(messages[-1]["content"])["writableTargetIds"], ["target"])

    def test_agent_validates_write_scope_types_and_duplicate_edits(self) -> None:
        config = LocalAppConfig(chatModelId="chat", providers=[AIProviderConfig(id="p", name="P", baseUrl="https://example.test/v1", apiKey="test")], registeredModels=[RegisteredModel(id="chat", providerId="p", modelId="chat-model", displayName="Chat", capabilityTags=["text"])])
        self.request.action = "agent"
        edit = {"targetNodeId": "target", "operation": "replace", "nodeType": "scene", "title": "Scene", "body": "Changed"}
        completion = AsyncMock()
        with patch("backend.app.assistant_workbench.read_local_app_config", return_value=config), patch("backend.app.assistant_workbench.create_chat_completion", new=completion):
            for edits in [[{**edit, "targetNodeId": "ref"}], [edit, edit], [{**edit, "nodeType": "paragraph"}], [{**edit, "body": " "}], [{**edit, "operation": "create", "nodeType": "container"}]]:
                completion.return_value = json.dumps({"reply": "Done", "edits": edits})
                with self.assertRaises(HTTPException):
                    asyncio.run(run_assistant(self.request))
            completion.return_value = json.dumps({"reply": "Reason", "edits": [edit]})
            self.assertEqual(asyncio.run(run_assistant(self.request)).edits[0].body, "Changed")
            self.assertEqual(self.target.body, "Aster negotiates.")
            completion.return_value = json.dumps({"reply": "Discussing only", "edits": []})
            self.assertEqual(asyncio.run(run_assistant(self.request)).edits, [])

    def test_agent_can_discuss_without_reading_unattached_nodes(self) -> None:
        request = AssistantRequest(project=self.project, targetNodeId="", action="agent", message="Discuss an idea")
        messages, context = build_messages(request)
        self.assertEqual(context.nodes, [])
        self.assertEqual(context.worldbook, [])
        self.assertEqual(json.loads(messages[-1]["content"])["writableTargetIds"], [])
        self.assertNotIn("DO NOT INCLUDE THIS", json.dumps(messages))


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._client_context = TestClient(app)
        cls.client = cls._client_context.__enter__()

    @classmethod
    def tearDownClass(cls) -> None:
        cls._client_context.__exit__(None, None, None)

    def test_context_endpoint_accepts_project_snapshot(self) -> None:
        target = node("target", "paragraph", "Target")
        response = self.client.post(
            "/api/context/preview",
            json={"project": ProjectFile(nodes=[target]).model_dump(mode="json"), "targetNodeId": target.id},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["mode"], "paragraph")

    def test_workbench_versions_round_trip_without_changing_node_body(self) -> None:
        target = node("work", "paragraph", "Draft", "Original")
        payload = ProjectFile(nodes=[target]).model_dump(mode="json")
        payload["workbench"] = {"work": {"messages": [{"id": "m", "role": "user", "content": "Improve dialogue", "createdAt": "now"}], "versions": [{"id": "v", "title": "Candidate", "body": "New text", "baseBody": "Original", "nodeType": "paragraph", "createdAt": "now"}], "activeVersionId": "v"}}
        payload["activeChatId"] = "__chat__:second"
        payload["workbench"]["__chat__:second"] = {"title": "Character design", "draft": "Keep this idea", "targetNodeIds": ["work"], "referenceNodeIds": []}
        self.assertEqual(self.client.put("/api/project", json=payload).status_code, 200)
        restored = self.client.get("/api/project").json()
        self.assertEqual(restored["nodes"][0]["body"], "Original")
        self.assertEqual(restored["workbench"]["work"]["versions"][0]["body"], "New text")
        self.assertEqual(restored["workbench"]["work"]["messages"][0]["content"], "Improve dialogue")
        self.assertEqual(restored["activeChatId"], "__chat__:second")
        self.assertEqual(restored["workbench"]["__chat__:second"]["draft"], "Keep this idea")
        self.assertEqual(restored["workbench"]["__chat__:second"]["title"], "Character design")

    def test_global_chat_selection_validates_model_and_preserves_provider_config(self) -> None:
        self.client.post("/api/providers/register", json={"id": "chat-provider", "name": "Chat", "baseUrl": "https://example.test/v1", "apiKey": "secret-chat", "headers": {}})
        self.client.post("/api/models/register", json={"providerId": "chat-provider", "modelId": "text", "capabilityTags": ["text"]})
        response = self.client.put("/api/assistant/model", json={"modelId": "chat-provider:text"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["chatModelId"], "chat-provider:text")
        self.assertNotIn("secret-chat", response.text)
        self.assertEqual(find_provider("chat-provider").apiKey, "secret-chat")
        self.assertEqual(self.client.put("/api/assistant/model", json={"modelId": "missing"}).status_code, 400)

    def test_removed_document_and_secret_endpoints_are_unavailable(self) -> None:
        self.assertEqual(self.client.post("/api/knowledge/documents", json={}).status_code, 404)
        self.assertEqual(self.client.put("/api/app-config", json={}).status_code, 405)

    def test_blank_provider_key_preserves_existing_secret(self) -> None:
        payload = {"id": "test", "name": "Test", "baseUrl": "https://example.test/v1", "headers": {}}
        self.assertEqual(self.client.post("/api/providers/register", json={**payload, "apiKey": "secret"}).status_code, 200)
        self.assertEqual(self.client.post("/api/providers/register", json={**payload, "apiKey": None}).status_code, 200)
        self.assertEqual(find_provider("test").apiKey, "secret")  # type: ignore[union-attr]
        self.assertEqual(self.client.post("/api/providers/register", json={**payload, "clearApiKey": True}).status_code, 200)
        self.assertEqual(find_provider("test").apiKey, "")  # type: ignore[union-attr]


if __name__ == "__main__":
    unittest.main()
