from backend.tests import environment as _test_environment

import base64
import unittest
from pydantic import ValidationError
from backend.app.models import ImageAttachment, ProjectFile
from backend.tests.test_core import node
from backend.app.export_txt import export_txt

PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="


class ImageTests(unittest.TestCase):
    def test_project_roundtrip_preserves_images_and_links(self):
        image = node("illustration", "image", "Castle", "A castle in the snow")
        image.image = ImageAttachment(dataUrl=PNG, fileName="castle.png")
        image.worldbookEntryIds = ["castle-entry"]
        project = ProjectFile(nodes=[image])
        restored = ProjectFile.model_validate_json(project.model_dump_json())
        self.assertEqual(restored.nodes[0].image.dataUrl, PNG)
        self.assertEqual(restored.nodes[0].worldbookEntryIds, ["castle-entry"])
        self.assertNotIn("base64", export_txt(restored, [], "assets"))
        self.assertEqual(export_txt(restored, [], "manuscript"), "")

    def test_rejects_remote_svg_corrupt_and_oversized_images(self):
        for value in ["https://example.com/a.png", "data:image/svg+xml;base64,PHN2Zz4=",
                      "data:image/png;base64,broken!", "data:image/png;base64,aGVsbG8=",
                      "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"x" * (2 * 1024 * 1024)).decode()]:
            with self.subTest(value=value[:60]), self.assertRaises(ValidationError):
                ImageAttachment(dataUrl=value, fileName="image.png")

    def test_legacy_projects_need_no_image_fields(self):
        project = ProjectFile.model_validate({"nodes": [node("old", "paragraph", "Old").model_dump(exclude={"image", "worldbookEntryIds"})]})
        self.assertIsNone(project.nodes[0].image)
        self.assertEqual(project.nodes[0].worldbookEntryIds, [])
