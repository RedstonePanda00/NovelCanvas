from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator


NodeType = Literal[
    "paragraph",
    "outline",
    "scene",
    "character",
    "supplemental_info",
    "instruction",
    "review",
    "container",
    "generic",
]

StructureWorkflow = Literal[
    "generate-outline",
    "generate-scenes",
    "generate-paragraph-tasks",
    "create-review-node",
]

EdgeSemantic = Literal[
    "must_follow",
    "instruction",
    "reference",
    "can_rewrite",
    "style_reference",
    "review_basis",
    "review_target",
]


class Point(BaseModel):
    x: float
    y: float


class Size(BaseModel):
    width: float
    height: float


class NodeMetadata(BaseModel):
    createdAt: str
    updatedAt: str
    sourceNodeIds: list[str] = Field(default_factory=list)
    generatedByWorkflow: str | None = None
    generatedPlanId: str | None = None
    tags: list[str] = Field(default_factory=list)


class EdgeMetadata(BaseModel):
    createdAt: str
    updatedAt: str
    sourceNodeIds: list[str] = Field(default_factory=list)
    generatedByWorkflow: str | None = None
    generatedPlanId: str | None = None
    tags: list[str] = Field(default_factory=list)


class CanvasNode(BaseModel):
    id: str
    type: NodeType
    title: str
    body: str | None = None
    position: Point
    size: Size
    metadata: NodeMetadata
    outlineLevel: str | None = None
    targetWordCount: int | None = None
    narrativeTask: str | None = None
    childNodeIds: list[str] = Field(default_factory=list)


class CanvasEdge(BaseModel):
    id: str
    sourceNodeId: str
    targetNodeId: str
    semantic: EdgeSemantic
    label: str | None = None
    metadata: EdgeMetadata | None = None


class AIGenerationPlan(BaseModel):
    id: str
    workflow: StructureWorkflow
    sourceNodeIds: list[str] = Field(default_factory=list)
    plannedNodes: list[CanvasNode] = Field(default_factory=list)
    plannedEdges: list[CanvasEdge] = Field(default_factory=list)
    createdAt: str
    acceptedAt: str | None = None
    rejectedAt: str | None = None
    regeneratedFromPlanId: str | None = None


class ModelRoutingSettings(BaseModel):
    structureDerivationModelId: str | None = None
    paragraphGenerationModelId: str | None = None
    reviewModelId: str | None = None
    contextCompressionModelId: str | None = None
    embeddingModelId: str | None = None


class WorldbookEntry(BaseModel):
    id: str
    title: str
    content: str
    keys: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    enabled: bool = True
    alwaysOn: bool = False
    priority: int = 0
    tokenBudget: int | None = None
    insertionPosition: Literal["before_context", "after_context"] = "after_context"


class Worldbook(BaseModel):
    entries: list[WorldbookEntry] = Field(default_factory=list)


class ProjectSettings(BaseModel):
    defaultLanguage: str = "en"
    defaultExportMode: Literal["assets", "manuscript"] = "assets"
    modelRouting: ModelRoutingSettings = Field(default_factory=ModelRoutingSettings)


class ProjectFile(BaseModel):
    version: str = "0.1.0"
    title: str = "Untitled Novel Canvas Project"
    nodes: list[CanvasNode] = Field(default_factory=list)
    edges: list[CanvasEdge] = Field(default_factory=list)
    worldbook: Worldbook = Field(default_factory=Worldbook)
    createdAt: str = ""
    updatedAt: str = ""
    settings: ProjectSettings = Field(default_factory=ProjectSettings)

    @model_validator(mode="after")
    def validate_graph_integrity(self) -> "ProjectFile":
        node_ids = [node.id for node in self.nodes]
        duplicate_node_ids = sorted({node_id for node_id in node_ids if node_ids.count(node_id) > 1})
        if duplicate_node_ids:
            raise ValueError(f"Duplicate node ids: {', '.join(duplicate_node_ids)}")

        edge_ids = [edge.id for edge in self.edges]
        duplicate_edge_ids = sorted({edge_id for edge_id in edge_ids if edge_ids.count(edge_id) > 1})
        if duplicate_edge_ids:
            raise ValueError(f"Duplicate edge ids: {', '.join(duplicate_edge_ids)}")

        node_id_set = set(node_ids)
        for edge in self.edges:
            if edge.sourceNodeId not in node_id_set:
                raise ValueError(f"Edge {edge.id} references missing source node {edge.sourceNodeId}")
            if edge.targetNodeId not in node_id_set:
                raise ValueError(f"Edge {edge.id} references missing target node {edge.targetNodeId}")

        for node in self.nodes:
            for child_node_id in node.childNodeIds:
                if child_node_id not in node_id_set:
                    raise ValueError(f"Node {node.id} references missing child node {child_node_id}")

        return self


class AIProviderConfig(BaseModel):
    id: str
    name: str
    baseUrl: str
    apiKey: str
    headers: dict[str, str] = Field(default_factory=dict)


class RegisteredModel(BaseModel):
    id: str
    providerId: str
    modelId: str
    displayName: str
    capabilityTags: list[str] = Field(default_factory=list)
    contextWindowTokens: int | None = None
    embeddingDimensions: int | None = None
    enabled: bool = True


class ProviderRegistrationRequest(BaseModel):
    id: str
    name: str
    baseUrl: str
    apiKey: str
    headers: dict[str, str] = Field(default_factory=dict)


class StructurePlanRequest(BaseModel):
    workflow: StructureWorkflow
    sourceNodeIds: list[str]


class ParagraphGenerationRequest(BaseModel):
    targetNodeId: str
    mode: Literal["replace", "append"] = "replace"


class ReviewGenerationRequest(BaseModel):
    targetNodeId: str


class NodeCompletionRequest(BaseModel):
    targetNodeId: str


class TxtExportRequest(BaseModel):
    nodeIds: list[str] = Field(default_factory=list)
    mode: Literal["assets", "manuscript"] = "assets"


class ProviderIdRequest(BaseModel):
    providerId: str


class ProviderTestRequest(BaseModel):
    providerId: str
    chatModelId: str | None = None
    embeddingModelId: str | None = None


class ProviderTestResult(BaseModel):
    modelListingOk: bool = False
    chatCompletionOk: bool | None = None
    embeddingOk: bool | None = None
    errors: list[str] = Field(default_factory=list)


class DiscoveredModel(BaseModel):
    id: str
    ownedBy: str | None = None


class ModelListResponse(BaseModel):
    models: list[DiscoveredModel] = Field(default_factory=list)


class RegisterModelRequest(BaseModel):
    providerId: str
    modelId: str
    displayName: str | None = None
    capabilityTags: list[str] = Field(default_factory=list)
    contextWindowTokens: int | None = None
    embeddingDimensions: int | None = None


class LocalAppConfig(BaseModel):
    providers: list[AIProviderConfig] = Field(default_factory=list)
    registeredModels: list[RegisteredModel] = Field(default_factory=list)


class PublicAIProviderConfig(BaseModel):
    id: str
    name: str
    baseUrl: str
    hasApiKey: bool
    headerKeys: list[str] = Field(default_factory=list)


class PublicLocalAppConfig(BaseModel):
    providers: list[PublicAIProviderConfig] = Field(default_factory=list)
    registeredModels: list[RegisteredModel] = Field(default_factory=list)


def to_public_local_app_config(config: LocalAppConfig) -> PublicLocalAppConfig:
    return PublicLocalAppConfig(
        providers=[
            PublicAIProviderConfig(
                id=provider.id,
                name=provider.name,
                baseUrl=provider.baseUrl,
                hasApiKey=bool(provider.apiKey),
                headerKeys=sorted(provider.headers.keys()),
            )
            for provider in config.providers
        ],
        registeredModels=config.registeredModels,
    )


class KnowledgeDocument(BaseModel):
    id: str
    title: str
    sourcePath: str | None = None
    tags: list[str] = Field(default_factory=list)
    chunkIds: list[str] = Field(default_factory=list)
    createdAt: str
    updatedAt: str


class KnowledgeBaseMetadata(BaseModel):
    id: str = "default"
    title: str = "Default Knowledge Base"
    documents: list[KnowledgeDocument] = Field(default_factory=list)
    embeddingModelId: str | None = None
    updatedAt: str = ""


class KnowledgeChunks(BaseModel):
    chunks: list[dict[str, Any]] = Field(default_factory=list)


class KnowledgeChunk(BaseModel):
    id: str
    documentId: str
    text: str
    ordinal: int
    createdAt: str


class KnowledgeIndexEntry(BaseModel):
    chunkId: str
    documentId: str
    embeddingModelId: str
    vector: list[float]


class KnowledgeIndex(BaseModel):
    entries: list[KnowledgeIndexEntry] = Field(default_factory=list)


class KnowledgeDocumentCreateRequest(BaseModel):
    title: str
    text: str
    tags: list[str] = Field(default_factory=list)


class KnowledgeReindexResult(BaseModel):
    indexedChunks: int
    embeddingModelId: str | None = None
    unavailableReason: str | None = None


class KnowledgeDocumentCreateResponse(BaseModel):
    metadata: KnowledgeBaseMetadata
    reindex: KnowledgeReindexResult


class RagPreviewRequest(BaseModel):
    targetNodeId: str
    limit: int = 5


class RagSnippet(BaseModel):
    chunkId: str
    documentId: str
    documentTitle: str
    text: str
    score: float


class RagPreviewResponse(BaseModel):
    authorized: bool
    authorizingNodeIds: list[str] = Field(default_factory=list)
    snippets: list[RagSnippet] = Field(default_factory=list)
    unavailableReason: str | None = None
