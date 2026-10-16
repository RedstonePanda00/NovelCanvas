"""Set isolated storage before any application module is imported, in any test order."""
import os
import tempfile
from pathlib import Path

TEMP = tempfile.TemporaryDirectory(prefix="novel-canvas-tests-")
ROOT = Path(TEMP.name)
os.environ["NOVEL_CANVAS_PROJECT_FILE"] = str(ROOT / "project.json")
os.environ["NOVEL_CANVAS_KNOWLEDGE_BASE_DIR"] = str(ROOT / "memory")
os.environ["NOVEL_CANVAS_CONFIG_DIR"] = str(ROOT / "config")
