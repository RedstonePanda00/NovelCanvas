from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import ValidationError

from .ai_provider import ProviderRequestError, list_models, test_chat_completion, test_embedding
from .models import (
    AIProviderConfig,
    AIGenerationPlan,
    KnowledgeBaseMetadata,
    KnowledgeDocumentCreateRequest,
    KnowledgeDocumentCreateResponse,
    KnowledgeReindexResult,
    LocalAppConfig,
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
    ReviewGenerationRequest,
    StructurePlanRequest,
    TxtExportRequest,
    to_public_local_app_config,
)
from .export_txt import export_txt
from .paragraph_generation import (
    ParagraphGenerationError,
    prepare_paragraph_generation,
    stream_paragraph_generation,
)
from .node_completion import NodeCompletionError, prepare_node_completion, stream_node_completion
from .rag import add_knowledge_document, preview_rag_for_target, reindex_knowledge_base
from .review_generation import ReviewGenerationError, prepare_review_generation, stream_review_generation
from .security import SecretValidationError
from .stores import (
    export_project,
    import_project,
    find_provider,
    initialize_storage,
    read_knowledge_metadata,
    read_local_app_config,
    read_project,
    storage_status,
    upsert_provider,
    upsert_registered_model,
    write_local_app_config,
    write_project,
)
from .structure_plans import StructurePlanError, generate_structure_plan


app = FastAPI(title="Novel Canvas API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
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


@app.put("/api/app-config")
def put_app_config(config: LocalAppConfig) -> LocalAppConfig:
    return write_local_app_config(config)


@app.get("/api/knowledge")
def get_knowledge() -> KnowledgeBaseMetadata:
    return read_knowledge_metadata()


@app.post("/api/knowledge/documents")
async def post_knowledge_document(request: KnowledgeDocumentCreateRequest) -> KnowledgeDocumentCreateResponse:
    if not request.text.strip():
        raise HTTPException(status_code=400, detail="Knowledge document text cannot be empty.")
    return await add_knowledge_document(request.title.strip() or "Untitled Document", request.text, request.tags)


@app.post("/api/knowledge/reindex")
async def post_knowledge_reindex() -> KnowledgeReindexResult:
    return await reindex_knowledge_base()


@app.post("/api/rag/preview")
async def post_rag_preview(request: RagPreviewRequest) -> RagPreviewResponse:
    return await preview_rag_for_target(request.targetNodeId, request.limit)


@app.post("/api/plans/structure")
async def post_structure_plan(request: StructurePlanRequest) -> AIGenerationPlan:
    try:
        return await generate_structure_plan(request.workflow, request.sourceNodeIds)
    except StructurePlanError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/generation/paragraph/stream")
async def post_paragraph_generation_stream(request: ParagraphGenerationRequest) -> StreamingResponse:
    try:
        session = await prepare_paragraph_generation(request.targetNodeId)
    except ParagraphGenerationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    async def stream() -> Any:
        try:
            async for chunk in stream_paragraph_generation(session):
                yield chunk
        except ParagraphGenerationError as exc:
            yield f"\n[Generation error: {exc}]"

    return StreamingResponse(stream(), media_type="text/plain; charset=utf-8")


@app.post("/api/generation/node-completion/stream")
async def post_node_completion_stream(request: NodeCompletionRequest) -> StreamingResponse:
    try:
        session = await prepare_node_completion(request.targetNodeId)
    except NodeCompletionError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    async def stream() -> Any:
        try:
            async for chunk in stream_node_completion(session):
                yield chunk
        except NodeCompletionError as exc:
            yield f"\n[Generation error: {exc}]"

    return StreamingResponse(stream(), media_type="text/plain; charset=utf-8")


@app.post("/api/generation/review/stream")
async def post_review_generation_stream(request: ReviewGenerationRequest) -> StreamingResponse:
    try:
        session = await prepare_review_generation(request.targetNodeId)
    except ReviewGenerationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    async def stream() -> Any:
        try:
            async for chunk in stream_review_generation(session):
                yield chunk
        except ReviewGenerationError as exc:
            yield f"\n[Generation error: {exc}]"

    return StreamingResponse(stream(), media_type="text/plain; charset=utf-8")


@app.post("/api/export/txt")
def post_export_txt(request: TxtExportRequest) -> StreamingResponse:
    text = export_txt(request.nodeIds, request.mode)
    return StreamingResponse(iter([text]), media_type="text/plain; charset=utf-8")


@app.post("/api/providers/register")
def post_provider_register(request: ProviderRegistrationRequest) -> PublicLocalAppConfig:
    provider = AIProviderConfig(
        id=request.id,
        name=request.name,
        baseUrl=request.baseUrl,
        apiKey=request.apiKey,
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
