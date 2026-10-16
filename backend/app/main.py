import json
from collections.abc import AsyncIterator
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import ValidationError

from .ai_provider import ProviderRequestError, list_models, test_chat_completion, test_embedding
from .models import (
    AIProviderConfig,
    AIGenerationPlan,
    ContextPreviewRequest,
    ContextPreviewResponse,
    KnowledgeBaseMetadata,
    KnowledgeReindexResult,
    MemoryReindexRequest,
    ModelListResponse,
    NodeCompletionRequest,
    ParagraphGenerationRequest,
    ProjectFile,
    ProviderIdRequest,
    ProviderRegistrationRequest,
    ProviderTestRequest,
    ProviderTestResult,
    PublicLocalAppConfig,
    RagPreviewRequest,
    RagPreviewResponse,
    RegisteredModel,
    RegisterModelRequest,
    StructurePlanRequest,
    TxtExportRequest,
    to_public_local_app_config,
)
from .export_txt import export_txt
from .context_preview import build_context_preview
from .paragraph_generation import (
    ParagraphGenerationError,
    prepare_paragraph_generation,
    stream_paragraph_generation,
)
from .node_completion import NodeCompletionError, prepare_node_completion, stream_node_completion
from .rag import memory_metadata_for_project, preview_rag_for_target, reindex_knowledge_base
from .security import SecretValidationError
from .stores import (
    export_project,
    import_project,
    find_provider,
    initialize_storage,
    read_local_app_config,
    read_project,
    storage_status,
    upsert_provider,
    upsert_registered_model,
    write_project,
)
from .structure_plans import StructurePlanError, generate_structure_plan
from .assistant_workbench import router as assistant_router
from .assistant_stream import router as assistant_stream_router
from .scene_stream import router as scene_stream_router


app = FastAPI(title="Novel Canvas API", version="0.2.0")
app.include_router(assistant_router)
app.include_router(assistant_stream_router)
app.include_router(scene_stream_router)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _ndjson(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"


async def _ndjson_events(chunks: AsyncIterator[str]) -> AsyncIterator[str]:
    try:
        async for chunk in chunks:
            if chunk:
                yield _ndjson({"type": "chunk", "text": chunk})
        yield _ndjson({"type": "done"})
    except RuntimeError as exc:
        yield _ndjson(
            {
                "type": "error",
                "error": {
                    "code": "generation_failed",
                    "message": str(exc),
                },
            }
        )


@app.on_event("startup")
def startup() -> None:
    initialize_storage()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/storage/status")
def get_storage_status() -> dict[str, str]:
    return storage_status()


@app.get("/api/project")
def get_project() -> ProjectFile:
    return read_project()


@app.put("/api/project")
def put_project(project: ProjectFile) -> ProjectFile:
    try:
        return write_project(project)
    except SecretValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/project/export")
def get_project_export() -> dict[str, Any]:
    try:
        return export_project()
    except SecretValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/project/import")
def post_project_import(data: dict[str, Any]) -> ProjectFile:
    try:
        return import_project(data)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.errors()) from exc
    except SecretValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/app-config")
def get_app_config() -> PublicLocalAppConfig:
    return to_public_local_app_config(read_local_app_config())


@app.post("/api/memory")
def post_memory_status(request: MemoryReindexRequest) -> KnowledgeBaseMetadata:
    return memory_metadata_for_project(request.project)


@app.post("/api/memory/reindex")
async def post_memory_reindex(request: MemoryReindexRequest) -> KnowledgeReindexResult:
    return await reindex_knowledge_base(request.project)


@app.post("/api/memory/preview")
async def post_rag_preview(request: RagPreviewRequest) -> RagPreviewResponse:
    return await preview_rag_for_target(request.project, request.targetNodeId, request.limit)


@app.post("/api/context/preview")
def post_context_preview(request: ContextPreviewRequest) -> ContextPreviewResponse:
    try:
        return build_context_preview(request.project, request.targetNodeId)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/plans/structure")
async def post_structure_plan(request: StructurePlanRequest) -> AIGenerationPlan:
    try:
        return await generate_structure_plan(
            request.project,
            request.workflow,
            request.sourceNodeIds,
            request.desiredCount,
        )
    except StructurePlanError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/generation/paragraph/stream")
async def post_paragraph_generation_stream(request: ParagraphGenerationRequest) -> StreamingResponse:
    try:
        session = await prepare_paragraph_generation(request.project, request.targetNodeId, request.mode)
    except ParagraphGenerationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return StreamingResponse(
        _ndjson_events(stream_paragraph_generation(session)),
        media_type="application/x-ndjson; charset=utf-8",
    )


@app.post("/api/generation/node-completion/stream")
async def post_node_completion_stream(request: NodeCompletionRequest) -> StreamingResponse:
    try:
        session = await prepare_node_completion(request.project, request.targetNodeId)
    except NodeCompletionError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return StreamingResponse(
        _ndjson_events(stream_node_completion(session)),
        media_type="application/x-ndjson; charset=utf-8",
    )


@app.post("/api/export/txt")
def post_export_txt(request: TxtExportRequest) -> StreamingResponse:
    text = export_txt(request.project, request.nodeIds, request.mode)
    return StreamingResponse(iter([text]), media_type="text/plain; charset=utf-8")


@app.post("/api/providers/register")
def post_provider_register(request: ProviderRegistrationRequest) -> PublicLocalAppConfig:
    existing = find_provider(request.id)
    if request.clearApiKey:
        api_key = ""
    elif request.apiKey:
        api_key = request.apiKey
    else:
        api_key = existing.apiKey if existing else ""
    provider = AIProviderConfig(
        id=request.id,
        name=request.name,
        baseUrl=request.baseUrl,
        apiKey=api_key,
        headers=request.headers,
    )
    config = upsert_provider(provider)
    return to_public_local_app_config(config)


@app.post("/api/providers/models")
async def post_provider_models(request: ProviderIdRequest) -> ModelListResponse:
    provider = find_provider(request.providerId)
    if provider is None:
        raise HTTPException(status_code=404, detail=f"Provider not found: {request.providerId}")

    try:
        models = await list_models(provider)
    except ProviderRequestError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return ModelListResponse(models=models)


@app.post("/api/providers/test")
async def post_provider_test(request: ProviderTestRequest) -> ProviderTestResult:
    provider = find_provider(request.providerId)
    if provider is None:
        raise HTTPException(status_code=404, detail=f"Provider not found: {request.providerId}")

    result = ProviderTestResult()

    try:
        await list_models(provider)
        result.modelListingOk = True
    except ProviderRequestError as exc:
        result.errors.append(str(exc))

    if request.chatModelId:
        try:
            await test_chat_completion(provider, request.chatModelId)
            result.chatCompletionOk = True
        except ProviderRequestError as exc:
            result.chatCompletionOk = False
            result.errors.append(str(exc))

    if request.embeddingModelId:
        try:
            await test_embedding(provider, request.embeddingModelId)
            result.embeddingOk = True
        except ProviderRequestError as exc:
            result.embeddingOk = False
            result.errors.append(str(exc))

    return result


@app.post("/api/models/register")
def post_model_register(request: RegisterModelRequest) -> PublicLocalAppConfig:
    provider = find_provider(request.providerId)
    if provider is None:
        raise HTTPException(status_code=404, detail=f"Provider not found: {request.providerId}")

    model = RegisteredModel(
        id=f"{request.providerId}:{request.modelId}",
        providerId=request.providerId,
        modelId=request.modelId,
        displayName=request.displayName or request.modelId,
        capabilityTags=request.capabilityTags,
        contextWindowTokens=request.contextWindowTokens,
        embeddingDimensions=request.embeddingDimensions,
        enabled=True,
    )
    config = upsert_registered_model(model)
    return to_public_local_app_config(config)
