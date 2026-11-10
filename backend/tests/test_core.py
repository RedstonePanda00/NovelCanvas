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
    def test_cached_project_tracks_disk_and_failed_writes(self):
        from backend.app import stores, runtime_mcp
        with tempfile.TemporaryDirectory() as directory, patch.object(stores, "PROJECT_FILE", Path(directory) / "p.json"):
            base = stores.write_project(ProjectFile(nodes=[node("p", "paragraph", "Original", "alpha")]))
            with patch.object(stores, "atomic_write_json", side_effect=OSError("disk full")):
                with self.assertRaises(OSError):
                    runtime_mcp.patch_node(base.updatedAt, "p", "alpha", "beta")
            self.assertEqual(stores.read_project().nodes[0].body, "alpha")
            stores.PROJECT_FILE.write_text('{"title":"Replacement on disk"}', encoding="utf-8")
            self.assertEqual(stores.read_project().title, "Replacement on disk")

    def test_memory_chunks_and_fingerprint_ignore_canvas_layout(self):
        from backend.app.rag import _chunk_text
        short = "\n\n".join(["paragraph" * 9] * 5)
        self.assertEqual(_chunk_text(short), [short])
        long = "x" * 1500 + "\n\n" + "y" * 1500
        chunks = _chunk_text(long)
        self.assertTrue(all(len(chunk) <= 1200 for chunk in chunks))
        self.assertLessEqual(len(chunks), 5)
        target = node("p", "paragraph", "Title", short)
        project = ProjectFile(nodes=[target])
        before = project_memory_fingerprint(project)
        target.position.x += 200
        target.metadata.updatedAt = "moved"
        self.assertEqual(before, project_memory_fingerprint(project))

    def test_reindex_embeds_only_changed_text(self):
        from backend.app import rag
        proj = ProjectFile(nodes=[node("a", "paragraph", "First", "alpha"),
                                  node("b", "scene", "Second", "beta")])
        proj.settings.modelRouting.embeddingModelId = "test-reuse"
        async def embed(_, texts):
            return [[1.0] for _ in texts], None
        with patch.object(rag, "_embedding_model_config", return_value=("test-reuse", "model", None)), \
                patch.object(rag, "_embed_texts", new=AsyncMock(side_effect=embed)) as mocked:
            asyncio.run(rag.reindex_knowledge_base(proj))
            proj.nodes[0].body = "changed"
            asyncio.run(rag.reindex_knowledge_base(proj))
            self.assertEqual(len(mocked.call_args.args[1]), 1)
            self.assertIn("changed", mocked.call_args.args[1][0])
            asyncio.run(rag.reindex_knowledge_base(proj))
            self.assertEqual(mocked.await_count, 2)


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


class LegacyProjectTests(unittest.TestCase):
    def setUp(self) -> None:
        self.target = node("target", "scene", "Negotiation", "Aster negotiates.")
        self.reference = node("ref", "character", "Aster", "Aster is cautious.")

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

class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._client_context = TestClient(app)
        cls.client = cls._client_context.__enter__()

    @classmethod
    def tearDownClass(cls) -> None:
        cls._client_context.__exit__(None, None, None)

    def test_model_roles_are_local_defaults_for_new_projects(self):
        from backend.app import stores
        from backend.app.models import ModelRoutingSettings
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(stores, "PROJECT_FILE", Path(directory) / "project.json"), \
                patch.object(stores, "LOCAL_APP_CONFIG_FILE", Path(directory) / "config.json"):
            legacy = ProjectFile()
            legacy.settings.modelRouting.structureDerivationModelId = "writer"
            stores.write_project(legacy)
            stores.initialize_storage()
            models = [RegisteredModel(id=id, providerId="p", modelId=id, displayName=id,
                                      capabilityTags=tags) for id, tags in (("writer", ["text"]), ("embed", ["embedding"]))]
            stores.write_local_app_config(LocalAppConfig(registeredModels=models))

            def new():
                response = self.client.post("/api/project/new", json={"title": "New"})
                self.assertEqual(response.status_code, 200)
                return ProjectFile.model_validate(response.json())

            first = new()
            self.assertEqual(first.settings.modelRouting.structureDerivationModelId, "writer")
            first.settings.modelRouting.embeddingModelId = "embed"
            self.assertEqual(self.client.put("/api/project", json=first.model_dump()).status_code, 200)
            imported = ProjectFile()
            imported.settings.modelRouting = ModelRoutingSettings(paragraphGenerationModelId="other")
            result = self.client.post("/api/project/import", json=imported.model_dump())
            self.assertEqual(result.json()["settings"]["modelRouting"]["paragraphGenerationModelId"], "other")
            stores.initialize_storage()
            second = new()
            self.assertEqual(second.settings.modelRouting, first.settings.modelRouting)
            second.settings.modelRouting.embeddingModelId = None
            self.assertEqual(self.client.put("/api/project", json=second.model_dump()).status_code, 200)
            models[0].enabled = False
            stores.write_local_app_config(LocalAppConfig(registeredModels=models))
            self.assertEqual(new().settings.modelRouting, ModelRoutingSettings())

    def test_runtime_tools_share_canvas_storage_and_reject_stale_writes(self) -> None:
        headers = {"host": "127.0.0.1:53173", "accept": "application/json, text/event-stream"}

        def rpc(method, params):
            response = self.client.post("/mcp", headers=headers, json={
                "jsonrpc": "2.0", "id": 1, "method": method, "params": params,
            })
            self.assertEqual(response.status_code, 200, response.text)
            return response.json()["result"]

        def call(name, **arguments):
            return rpc("tools/call", {"name": name, "arguments": arguments})

        hello = rpc("initialize", {"protocolVersion": "2025-11-25", "capabilities": {},
                                   "clientInfo": {"name": "test", "version": "1"}})
        self.assertEqual(hello["serverInfo"]["name"], "NovelCanvas")
        self.assertIn("patch_node", [tool["name"] for tool in rpc("tools/list", {})["tools"]])
        base = self.client.put("/api/project", json={"title": "Runtime fixture"}).json()
        response = self.client.get("/api/project", headers={"X-Project-Revision": base["updatedAt"]})
        self.assertEqual(response.status_code, 304)
        self.assertEqual(response.content, b"")
        created = call("create_node", revision=base["updatedAt"], node_type="scene",
                       title="Arrival", body="An unopened letter.")["structuredContent"]
        read = call("read_node", node_id=created["id"])["structuredContent"]
        self.assertEqual(read["body"], "An unopened letter.")
        args = {"revision": read["revision"], "node_id": created["id"],
                "old_text": "unopened", "new_text": "opened"}
        self.assertFalse(call("patch_node", **args)["isError"])
        self.assertTrue(call("patch_node", **args)["isError"])
        self.assertEqual(self.client.put("/api/project", headers={"X-Project-Revision": base["updatedAt"]},
                                         json=base).status_code, 409)
        self.assertEqual(self.client.get("/api/project").json()["nodes"][0]["body"], "An opened letter.")

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
