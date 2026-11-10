from __future__ import annotations

from datetime import datetime, timezone
from threading import RLock

from pydantic import ValidationError

from .json_store import atomic_write_json, read_json
from .models import (
    AIProviderConfig,
    KnowledgeBaseMetadata,
    KnowledgeChunk,
    KnowledgeChunks,
    KnowledgeIndex,
    LocalAppConfig,
    ModelRoutingSettings,
    ProjectSettings,
    ProjectFile,
    RegisteredModel,
)
from .paths import (
    KNOWLEDGE_BASE_DIR,
    KNOWLEDGE_CHUNKS_FILE,
    KNOWLEDGE_INDEX_DIR,
    KNOWLEDGE_METADATA_FILE,
    LOCAL_APP_CONFIG_FILE,
    PROJECT_FILE,
)
from .security import assert_no_secrets


project_lock = RLock()
_cached_project: ProjectFile | None = None
_cached_signature: tuple | None = None


def _project_signature():
    stat = PROJECT_FILE.stat()
    return PROJECT_FILE, stat.st_ino, stat.st_mtime_ns, stat.st_size


KNOWLEDGE_INDEX_FILE = KNOWLEDGE_INDEX_DIR / "vector-index.json"


def ensure_project_file() -> ProjectFile:
    if not PROJECT_FILE.exists():
        project = ProjectFile()
        project.settings.modelRouting = available_routing_defaults()
        return write_project(project)

    global _cached_project, _cached_signature
    signature = _project_signature()
    if signature != _cached_signature or _cached_project is None:
        _cached_project = ProjectFile.model_validate(read_json(PROJECT_FILE))
        _cached_signature = signature
    return _cached_project


def read_project() -> ProjectFile:
    """Shared read-only snapshot. Writers replace changed branches before publishing."""
    with project_lock:
        return ensure_project_file()


def write_project(project: ProjectFile) -> ProjectFile:
    global _cached_project, _cached_signature
    with project_lock:
        saved = project.model_copy(update={"updatedAt": datetime.now(timezone.utc).isoformat()})
        data = saved.model_dump(mode="json")
        assert_no_secrets(data)
        atomic_write_json(PROJECT_FILE, data, compact=True)
        _cached_project = saved
        _cached_signature = _project_signature()
        return saved


def read_routing_defaults() -> ModelRoutingSettings:
    path = LOCAL_APP_CONFIG_FILE.with_name("model-routing.json")
    if path.exists():
        return ModelRoutingSettings.model_validate(read_json(path))
    return ModelRoutingSettings()


def available_routing_defaults() -> ModelRoutingSettings:
    defaults = read_routing_defaults()
    enabled = {model.id: model for model in read_local_app_config().registeredModels if model.enabled}
    for role, model_id in defaults.model_dump().items():
        model = enabled.get(model_id)
        if not model or (role == "embeddingModelId" and "embedding" not in model.capabilityTags):
            setattr(defaults, role, None)
    return defaults


def create_project(title: str) -> ProjectFile:
    with project_lock:
        settings = ProjectSettings(defaultLanguage="zh-CN", defaultExportMode="manuscript",
                                   modelRouting=available_routing_defaults())
        return write_project(ProjectFile(title=title, createdAt=datetime.now(timezone.utc).isoformat(), settings=settings))


def save_project_edits(project: ProjectFile, previous: ProjectFile) -> ProjectFile:
    """Called under project_lock. Only edited roles become new local defaults."""
    before = previous.settings.modelRouting.model_dump()
    after = project.settings.modelRouting.model_dump()
    changes = {key: value for key, value in after.items() if before[key] != value}
    if not changes or project.createdAt != previous.createdAt:
        return write_project(project)

    path = LOCAL_APP_CONFIG_FILE.with_name("model-routing.json")
    defaults = read_routing_defaults()
    atomic_write_json(path, defaults.model_copy(update=changes).model_dump())
    try:
        return write_project(project)
    except Exception:
        atomic_write_json(path, defaults.model_dump())
        raise


def import_project(data: dict) -> ProjectFile:
    try:
        project = ProjectFile.model_validate(data)
    except ValidationError:
        raise
    return write_project(project)


def export_project() -> dict:
    project = read_project()
    data = project.model_dump(mode="json")
    assert_no_secrets(data)
    return data


def ensure_knowledge_base() -> None:
    KNOWLEDGE_INDEX_DIR.mkdir(parents=True, exist_ok=True)

    if not KNOWLEDGE_METADATA_FILE.exists():
        atomic_write_json(KNOWLEDGE_METADATA_FILE, KnowledgeBaseMetadata().model_dump(mode="json"))

    if not KNOWLEDGE_CHUNKS_FILE.exists():
        atomic_write_json(KNOWLEDGE_CHUNKS_FILE, KnowledgeChunks().model_dump(mode="json"))

    if not KNOWLEDGE_INDEX_FILE.exists():
        atomic_write_json(KNOWLEDGE_INDEX_FILE, KnowledgeIndex().model_dump(mode="json"))


def ensure_local_app_config() -> LocalAppConfig:
    if not LOCAL_APP_CONFIG_FILE.exists():
        config = LocalAppConfig()
        write_local_app_config(config)
        return config

    return LocalAppConfig.model_validate(read_json(LOCAL_APP_CONFIG_FILE))


def read_local_app_config() -> LocalAppConfig:
    return ensure_local_app_config()


def write_local_app_config(config: LocalAppConfig) -> LocalAppConfig:
    atomic_write_json(LOCAL_APP_CONFIG_FILE, config.model_dump(mode="json"))
    return config


def upsert_provider(provider: AIProviderConfig) -> LocalAppConfig:
    config = read_local_app_config()
    providers = [item for item in config.providers if item.id != provider.id]
    providers.append(provider)
    config.providers = providers
    return write_local_app_config(config)


def find_provider(provider_id: str) -> AIProviderConfig | None:
    config = read_local_app_config()
    return next((provider for provider in config.providers if provider.id == provider_id), None)


def find_registered_model(model_id: str) -> RegisteredModel | None:
    config = read_local_app_config()
    return next((model for model in config.registeredModels if model.id == model_id), None)


def upsert_registered_model(model: RegisteredModel) -> LocalAppConfig:
    config = read_local_app_config()
    models = [item for item in config.registeredModels if item.id != model.id]
    models.append(model)
    config.registeredModels = models
    return write_local_app_config(config)


def read_knowledge_metadata() -> KnowledgeBaseMetadata:
    ensure_knowledge_base()
    return KnowledgeBaseMetadata.model_validate(read_json(KNOWLEDGE_METADATA_FILE))


def write_knowledge_metadata(metadata: KnowledgeBaseMetadata) -> KnowledgeBaseMetadata:
    atomic_write_json(KNOWLEDGE_METADATA_FILE, metadata.model_dump(mode="json"))
    return metadata


def read_knowledge_chunks() -> KnowledgeChunks:
    ensure_knowledge_base()
    return KnowledgeChunks.model_validate(read_json(KNOWLEDGE_CHUNKS_FILE))


def write_knowledge_chunks(chunks: KnowledgeChunks) -> KnowledgeChunks:
    atomic_write_json(KNOWLEDGE_CHUNKS_FILE, chunks.model_dump(mode="json"))
    return chunks


def read_knowledge_index() -> KnowledgeIndex:
    ensure_knowledge_base()
    return KnowledgeIndex.model_validate(read_json(KNOWLEDGE_INDEX_FILE))


def write_knowledge_index(index: KnowledgeIndex) -> KnowledgeIndex:
    atomic_write_json(KNOWLEDGE_INDEX_FILE, index.model_dump(mode="json"))
    return index


def get_knowledge_chunk_map() -> dict[str, KnowledgeChunk]:
    chunks = read_knowledge_chunks()
    return {
        chunk.id: chunk
        for chunk in (KnowledgeChunk.model_validate(item) for item in chunks.chunks)
    }


def initialize_storage() -> None:
    project = ensure_project_file()
    # Upgrade installations with model roles already selected in the open project.
    path = LOCAL_APP_CONFIG_FILE.with_name("model-routing.json")
    if not path.exists():
        atomic_write_json(path, project.settings.modelRouting.model_dump())
    ensure_knowledge_base()
    ensure_local_app_config()


def storage_status() -> dict[str, str]:
    return {
        "projectFile": str(PROJECT_FILE),
        "knowledgeBaseDir": str(KNOWLEDGE_BASE_DIR),
        "localAppConfigFile": str(LOCAL_APP_CONFIG_FILE),
    }
