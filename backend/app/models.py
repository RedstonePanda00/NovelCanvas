from __future__ import annotations

from collections import Counter
import json

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator
from .legacy_review import migrate_review_node


NodeType = Literal[
    "paragraph",
    "outline",
    "scene",
    "character",
    "supplemental_info",
    "instruction",
    "container",
]

StructureWorkflow = Literal[
    "generate-outline",
    "generate-scenes",
    "generate-paragraph-tasks",
    "generate-next-scene",
    "split-scene",
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
    @model_validator(mode="before")
    @classmethod
    def migrate_legacy_review(cls, value: Any) -> Any:
        return migrate_review_node(value)

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
    replacedNodeIds: list[str] = Field(default_factory=list)


class ModelRoutingSettings(BaseModel):
    structureDerivationModelId: str | None = None
    paragraphGenerationModelId: str | None = None
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
    modelGlobalPrompts: dict[str, dict[str, str]] = Field(default_factory=dict)


class ChatBlock(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    body: str = Field(min_length=1, max_length=50000)


class WorkbenchMessage(BaseModel):
    id: str
    role: Literal["user", "assistant"]
    content: str
    createdAt: str
    blocks: list[ChatBlock] = Field(default_factory=list, max_length=12)


class DraftVersion(BaseModel):
    @field_validator("nodeType", mode="before")
    @classmethod
    def migrate_legacy_type(cls, value: Any) -> Any:
        return "supplemental_info" if value == "review" else value

    @field_validator("appliedNodeSnapshot", mode="before")
    @classmethod
    def migrate_legacy_snapshot(cls, value: Any) -> Any:
        if not value or not isinstance(value, str):
            return value
        try:
            return json.dumps(migrate_review_node(json.loads(value)), ensure_ascii=False)
        except (ValueError, TypeError):
            return value

    id: str
    parentId: str | None = None
    title: str
    body: str
    baseBody: str
    baseTitle: str | None = None
    proposedNodeId: str | None = None
    creationSourceNodeIds: list[str] = Field(default_factory=list)
    feedback: str = ""
    preserve: str = ""
    rationale: str = ""
    nodeType: NodeType
    operation: Literal["replace", "create"] = "replace"
    status: Literal["pending", "accepted", "rejected", "rolled_back"] = "pending"
    targetNodeId: str | None = None
    appliedNodeId: str | None = None
    appliedNodeSnapshot: str | None = None
    conflict: str = ""
    createdAt: str
    referenceNodeIds: list[str] = Field(default_factory=list)
    worldbookEntryIds: list[str] = Field(default_factory=list)


class AgentMutation(BaseModel):
    id: str
    kind: Literal["edge", "worldbook", "node_delete", "node_links"]
    targetId: str
    before: dict[str, Any] | None = None
    after: dict[str, Any] | None = None
    status: Literal["pending", "accepted", "rolled_back"] = "pending"
    conflict: str = ""
    createdAt: str
    index: int | None = None


class AgentActivity(BaseModel):
    step: int
    tool: str
    nodeId: str | None = None
    title: str | None = None
    changedCount: int = 0
    message: str = ""
    total: int | None = None
    nextOffset: int | None = None
    completed: int = 0
    planned: int = 0


class AgentRun(BaseModel):
    id: str = ""
    instruction: str = ""
    requestMessage: str = ""
    targetNodeIds: list[str] = Field(default_factory=list)
    referenceNodeIds: list[str] = Field(default_factory=list)
    checkpoint: dict[str, Any] | None = None
    activities: list[AgentActivity] = Field(default_factory=list, max_length=100)
    status: Literal["running", "paused", "failed", "completed"] = "paused"
    error: str = ""


class NodeWorkbench(BaseModel):
    title: str = ""
    draft: str = ""
    messages: list[WorkbenchMessage] = Field(default_factory=list)
    versions: list[DraftVersion] = Field(default_factory=list)
    activeVersionId: str | None = None
    targetNodeIds: list[str] = Field(default_factory=list)
    referenceNodeIds: list[str] = Field(default_factory=list)
    scope: Literal["project", "attached"] = "project"
    agentRun: AgentRun | None = None
    mutations: list[AgentMutation] = Field(default_factory=list)
    agentPreconditions: dict[str, Any] | None = None


class ProjectFile(BaseModel):
    version: str = "0.1.0"
    title: str = "Untitled Novel Canvas Project"
    nodes: list[CanvasNode] = Field(default_factory=list)
    edges: list[CanvasEdge] = Field(default_factory=list)
    worldbook: Worldbook = Field(default_factory=Worldbook)
    createdAt: str = ""
    updatedAt: str = ""
    settings: ProjectSettings = Field(default_factory=ProjectSettings)
    workbench: dict[str, NodeWorkbench] = Field(default_factory=dict)
    activeChatId: str | None = None

    @model_validator(mode="after")
    def retain_latest_conversation_artifacts(self) -> "ProjectFile":
        workbench = dict(self.workbench)
        for key, work in workbench.items():
            if key != "__chat__" and not key.startswith("__chat__:"):
                continue
            latest = max(([work.versions[-1].createdAt] if work.versions else [])
                         + ([work.mutations[-1].createdAt] if work.mutations else []), default=None)
            versions = [version for version in work.versions if version.createdAt == latest]
            mutations = [change for change in work.mutations if change.createdAt == latest]
            last_report = max((i for i, message in enumerate(work.messages) if message.blocks), default=-1)
            messages = [message.model_copy(update={"blocks": []}) if message.blocks and i != last_report else message for i, message in enumerate(work.messages)]
            active = work.activeVersionId if any(version.id == work.activeVersionId for version in versions) else versions[-1].id if versions else None
            workbench[key] = work.model_copy(update={"versions": versions, "mutations": mutations, "messages": messages, "activeVersionId": active})
        self.workbench = workbench
        return self

    @model_validator(mode="after")
    def validate_graph_integrity(self) -> "ProjectFile":
        node_ids = [node.id for node in self.nodes]
        duplicate_node_ids = sorted({node_id for node_id, count in Counter(node_ids).items() if count > 1})
        if duplicate_node_ids:
            raise ValueError(f"Duplicate node ids: {', '.join(duplicate_node_ids)}")

        edge_ids = [edge.id for edge in self.edges]
        duplicate_edge_ids = sorted({edge_id for edge_id, count in Counter(edge_ids).items() if count > 1})
        if duplicate_edge_ids:
            raise ValueError(f"Duplicate edge ids: {', '.join(duplicate_edge_ids)}")

        node_id_set = set(node_ids)
        for edge in self.edges:
            if edge.sourceNodeId not in node_id_set:
                raise ValueError(f"Edge {edge.id} references missing source node {edge.sourceNodeId}")
            if edge.targetNodeId not in node_id_set:
                raise ValueError(f"Edge {edge.id} references missing target node {edge.targetNodeId}")

        for node in self.nodes:
            if len(node.childNodeIds) != len(set(node.childNodeIds)):
                raise ValueError(f"Node {node.id} contains duplicate child node ids")
            for child_node_id in node.childNodeIds:
                if child_node_id not in node_id_set:
                    raise ValueError(f"Node {node.id} references missing child node {child_node_id}")

        child_ids_by_node = {node.id: node.childNodeIds for node in self.nodes}
        visiting: set[str] = set()
        visited: set[str] = set()

        def visit(node_id: str) -> None:
            if node_id in visiting:
                raise ValueError(f"Container hierarchy contains a cycle at node {node_id}")
            if node_id in visited:
                return
            visiting.add(node_id)
            for child_id in child_ids_by_node.get(node_id, []):
                visit(child_id)
            visiting.remove(node_id)
            visited.add(node_id)

        for node_id in node_ids:
            visit(node_id)

        return self


class AIProviderConfig(BaseModel):
    id: str
    name: str
    baseUrl: str
    apiKey: str
    headers: dict[str, str] = Field(default_factory=dict)


class RegisteredModel(BaseModel):
    @field_validator("capabilityTags", mode="before")
    @classmethod
    def migrate_review_capability(cls, value: Any) -> Any:
        return list(dict.fromkeys("text" if item == "review" else item for item in value)) if isinstance(value, list) else value

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
    apiKey: str | None = None
    clearApiKey: bool = False
    headers: dict[str, str] = Field(default_factory=dict)


class StructurePlanRequest(BaseModel):
    project: ProjectFile
    workflow: StructureWorkflow
    sourceNodeIds: list[str]
    desiredCount: int | None = None


class ParagraphGenerationRequest(BaseModel):
    project: ProjectFile
    targetNodeId: str
    mode: Literal["replace", "append"] = "replace"


class NodeCompletionRequest(BaseModel):
    project: ProjectFile
    targetNodeId: str


class TxtExportRequest(BaseModel):
    project: ProjectFile
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
    chatModelId: str | None = None
    providers: list[AIProviderConfig] = Field(default_factory=list)
    registeredModels: list[RegisteredModel] = Field(default_factory=list)


class PublicAIProviderConfig(BaseModel):
    id: str
    name: str
    baseUrl: str
    hasApiKey: bool
    headerKeys: list[str] = Field(default_factory=list)


class PublicLocalAppConfig(BaseModel):
    chatModelId: str | None = None
    providers: list[PublicAIProviderConfig] = Field(default_factory=list)
    registeredModels: list[RegisteredModel] = Field(default_factory=list)


def to_public_local_app_config(config: LocalAppConfig) -> PublicLocalAppConfig:
    return PublicLocalAppConfig(
        chatModelId=config.chatModelId,
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
    id: str = "project-memory"
    title: str = "Project Memory"
    documents: list[KnowledgeDocument] = Field(default_factory=list)
    embeddingModelId: str | None = None
    sourceFingerprint: str = ""
    stale: bool = False
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


class KnowledgeReindexResult(BaseModel):
    indexedChunks: int
    embeddingModelId: str | None = None
    unavailableReason: str | None = None


class RagPreviewRequest(BaseModel):
    project: ProjectFile
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
    stale: bool = False


class MemoryReindexRequest(BaseModel):
    project: ProjectFile


class ContextPreviewRequest(BaseModel):
    project: ProjectFile
    targetNodeId: str


class ContextPreviewItem(BaseModel):
    edgeId: str
    nodeId: str
    title: str
    nodeType: NodeType
    semantic: EdgeSemantic
    estimatedTokens: int


class ContextPreviewExcluded(BaseModel):
    edgeId: str
    nodeId: str | None = None
    reasonCode: str
    reason: str


class ContextPreviewResponse(BaseModel):
    mode: Literal["paragraph", "unsupported"]
    items: list[ContextPreviewItem] = Field(default_factory=list)
    excluded: list[ContextPreviewExcluded] = Field(default_factory=list)
    estimatedTokens: int = 0
    compressionThreshold: int = 12000
    memoryStale: bool = False
