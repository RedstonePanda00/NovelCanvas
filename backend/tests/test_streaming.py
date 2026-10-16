
from backend.tests import environment as _test_environment
import asyncio
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from backend.app.assistant_stream import stream_assistant
from backend.app.assistant_workbench import AssistantRequest
from backend.app.json_stream import partial_json
from backend.app.models import AIProviderConfig, CanvasNode, LocalAppConfig, NodeMetadata, Point, ProjectFile, RegisteredModel, Size
from backend.app.scene_stream import SceneStreamRequest, stream_scenes


def outline_project():
    node = CanvasNode(id="outline", type="outline", title="Outline", body="A negotiation ends in a failed promise.", position=Point(x=0, y=0), size=Size(width=300, height=250), metadata=NodeMetadata(createdAt="now", updatedAt="now"))
    return ProjectFile(nodes=[node])


class StreamingTests(unittest.TestCase):
    def test_partial_strings_handle_escaping_and_unicode_boundaries(self):
        payload = {"reply": '中文 "quoted"\nline 😀', "blocks": [{"title": "Report", "body": "Evidence"}]}
        raw = json.dumps(payload)
        for end in range(1, len(raw) + 1):
            value = partial_json(raw[:end])
            if isinstance(value, dict) and isinstance(value.get("reply"), str):
                value["reply"].encode("utf-8")
                self.assertTrue(payload["reply"].startswith(value["reply"]))
        self.assertEqual(partial_json(raw), payload)

    def test_chat_yields_preview_before_final_validation(self):
        config = LocalAppConfig(chatModelId="m", providers=[AIProviderConfig(id="p", name="P", baseUrl="https://example.test", apiKey="")], registeredModels=[RegisteredModel(id="m", providerId="p", modelId="model", displayName="Model", capabilityTags=["text"])])
        completed = False

        async def chunks(*args, **kwargs):
            nonlocal completed
            self.assertTrue(kwargs["json_response"])
            yield '{"reply":"Working'
            yield ' on it","blocks":[{"title":"Report","body":"Finding"}],"edits":[]}'
            completed = True

        async def run():
            response = stream_assistant(AssistantRequest(project=outline_project(), targetNodeId="outline", action="agent", message="Review"))
            first = json.loads(await anext(response.body_iterator))
            self.assertEqual(first["reply"], "Working")
            self.assertFalse(completed)
            remaining = [json.loads(item) async for item in response.body_iterator]
            self.assertEqual(remaining[-1]["type"], "done")
            self.assertEqual(remaining[-1]["response"]["blocks"][0]["body"], "Finding")

        with patch("backend.app.assistant_stream.read_local_app_config", return_value=config), patch("backend.app.assistant_stream.stream_chat_completion", new=chunks):
            asyncio.run(run())

    def test_scene_stream_fills_exact_count_and_rejects_incomplete_output(self):
        routed = SimpleNamespace(provider=object(), registered=SimpleNamespace(id="m", modelId="model", contextWindowTokens=None))
        request = SceneStreamRequest(project=outline_project(), sourceNodeIds=["outline"], desiredCount=2)

        async def chunks(*args, **kwargs):
            yield '{"nodes":[{"title":"First","body":"Partial'
            yield ' scene"},{"title":"Second","body":"Complete scene"}]}'

        async def broken(*args, **kwargs):
            yield '{"nodes":[{"title":"Only one","body":"Incomplete batch"}]}'

        async def collect():
            return [json.loads(item) async for item in stream_scenes(request).body_iterator]

        with patch("backend.app.scene_stream.resolve_routed_model", return_value=routed), patch("backend.app.scene_stream.stream_chat_completion", new=chunks):
            events = asyncio.run(collect())
            self.assertEqual(events[0]["nodes"][0]["body"], "Partial")
            self.assertEqual(events[-1]["type"], "done")
            self.assertEqual(len(events[-1]["nodes"]), 2)
        with patch("backend.app.scene_stream.resolve_routed_model", return_value=routed), patch("backend.app.scene_stream.stream_chat_completion", new=broken):
            events = asyncio.run(collect())
            self.assertEqual(events[-1]["type"], "error")
            self.assertFalse(any(event["type"] == "done" for event in events))

    def test_project_keeps_only_latest_reports_and_latest_edit_batch_per_conversation(self):
        project = outline_project().model_dump()
        version = {"id": "old", "title": "Old", "body": "Old", "baseBody": "Original", "nodeType": "outline", "createdAt": "1"}
        project["workbench"] = {"__chat__": {"messages": [
            {"id": "a", "role": "assistant", "content": "Old report", "createdAt": "1", "blocks": [{"title": "Old", "body": "Old text"}]},
            {"id": "b", "role": "assistant", "content": "New report", "createdAt": "2", "blocks": [{"title": "New", "body": "New text"}]},
        ], "versions": [version, {**version, "id": "new", "createdAt": "2"}]}}
        work = ProjectFile.model_validate(project).workbench["__chat__"]
        self.assertEqual([item.id for item in work.versions], ["new"])
        self.assertEqual(work.messages[0].blocks, [])
        self.assertEqual(work.messages[1].blocks[0].body, "New text")
