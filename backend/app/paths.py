from __future__ import annotations

import os
from pathlib import Path


BACKEND_DIR = Path(__file__).resolve().parents[1]
PROJECT_ROOT = BACKEND_DIR.parent

PROJECT_FILE = Path(os.environ.get("NOVEL_CANVAS_PROJECT_FILE", PROJECT_ROOT / "project.json"))
KNOWLEDGE_BASE_DIR = Path(os.environ.get("NOVEL_CANVAS_KNOWLEDGE_BASE_DIR", PROJECT_ROOT / "knowledge-base"))
KNOWLEDGE_DOCUMENTS_DIR = KNOWLEDGE_BASE_DIR / "documents"
KNOWLEDGE_INDEX_DIR = KNOWLEDGE_BASE_DIR / "index"
KNOWLEDGE_METADATA_FILE = KNOWLEDGE_BASE_DIR / "metadata.json"
KNOWLEDGE_CHUNKS_FILE = KNOWLEDGE_BASE_DIR / "chunks.json"


def app_config_dir() -> Path:
    override = os.environ.get("NOVEL_CANVAS_CONFIG_DIR")
    if override:
        return Path(override)

    base = os.environ.get("APPDATA")
    if base:
        return Path(base) / "NovelCanvas"
    return Path.home() / ".novelcanvas"


LOCAL_APP_CONFIG_FILE = app_config_dir() / "local-app-config.json"
