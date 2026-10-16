/* eslint-disable */
// Generated from FastAPI OpenAPI. Do not edit by hand.
// Schema digest: 0362e2ffaa5b1a68

export interface AIGenerationPlan {
  "id": string;
  "workflow": "generate-outline" | "generate-scenes" | "generate-paragraph-tasks" | "generate-next-scene" | "split-scene";
  "sourceNodeIds"?: Array<string>;
  "plannedNodes"?: Array<CanvasNode>;
  "plannedEdges"?: Array<CanvasEdge>;
  "createdAt": string;
  "acceptedAt"?: string | null;
  "rejectedAt"?: string | null;
  "regeneratedFromPlanId"?: string | null;
  "replacedNodeIds"?: Array<string>;
}

export interface AgentActivity {
  "step": number;
  "tool": string;
  "nodeId"?: string | null;
  "title"?: string | null;
  "changedCount"?: number;
  "message"?: string;
  "total"?: number | null;
  "nextOffset"?: number | null;
  "completed"?: number;
  "planned"?: number;
}

export interface AgentEdit {
  "title": string;
  "body": string;
  "targetNodeId": string;
  "operation": "replace" | "create";
  "nodeType": "paragraph" | "outline" | "scene" | "character" | "supplemental_info" | "instruction" | "container";
}

export interface AgentMutation {
  "id": string;
  "kind": "edge" | "worldbook" | "node_delete" | "node_links";
  "targetId": string;
  "before"?: Record<string, unknown> | null;
  "after"?: Record<string, unknown> | null;
  "status"?: "pending" | "accepted" | "rolled_back";
  "conflict"?: string;
  "createdAt": string;
  "index"?: number | null;
}

export interface AgentRun {
  "id"?: string;
  "instruction"?: string;
  "requestMessage"?: string;
  "targetNodeIds"?: Array<string>;
  "referenceNodeIds"?: Array<string>;
  "checkpoint"?: Record<string, unknown> | null;
  "activities"?: Array<AgentActivity>;
  "status"?: "running" | "paused" | "failed" | "completed";
  "error"?: string;
}

export interface AssistantContext {
  "nodes": Array<ContextItem>;
  "worldbook": Array<ContextItem>;
  "relationships"?: Array<Record<string, string>>;
}

export interface AssistantRequest {
  "project": ProjectFile;
  "scope"?: "attached" | "project";
  "checkpoint"?: Record<string, unknown> | null;
  "targetNodeId": string;
  "targetNodeIds"?: Array<string>;
  "referenceNodeIds"?: Array<string>;
  "includeWorldbook"?: boolean;
  "excludedWorldbookIds"?: Array<string>;
  "action"?: "discuss" | "revise" | "create" | "agent";
  "message": string;
  "preserve"?: string;
  "baseText"?: string | null;
  "outputType"?: "paragraph" | "outline" | "scene" | "character" | "supplemental_info" | "instruction" | "container";
  "history"?: Array<HistoryMessage>;
}

export interface AssistantResponse {
  "reply": string;
  "blocks"?: Array<ChatBlock>;
  "proposal"?: Proposal | null;
  "context": AssistantContext;
  "edits"?: Array<AgentEdit>;
}

export interface CanvasEdge {
  "id": string;
  "sourceNodeId": string;
  "targetNodeId": string;
  "semantic": "must_follow" | "instruction" | "reference" | "can_rewrite" | "style_reference" | "review_basis" | "review_target";
  "label"?: string | null;
  "metadata"?: EdgeMetadata | null;
}

export interface CanvasNode {
  "id": string;
  "type": "paragraph" | "outline" | "scene" | "character" | "supplemental_info" | "instruction" | "container";
  "title": string;
  "body"?: string | null;
  "position": Point;
  "size": Size;
  "metadata": NodeMetadata;
  "outlineLevel"?: string | null;
  "targetWordCount"?: number | null;
  "narrativeTask"?: string | null;
  "childNodeIds"?: Array<string>;
}

export interface ChatBlock {
  "title": string;
  "body": string;
}

export interface ChatModelSelection {
  "modelId"?: string | null;
}

export interface ContextItem {
  "id": string;
  "title": string;
  "content": string;
  "nodeType"?: "paragraph" | "outline" | "scene" | "character" | "supplemental_info" | "instruction" | "container" | null;
  "relationships"?: Array<string>;
}

export interface ContextPreviewExcluded {
  "edgeId": string;
  "nodeId"?: string | null;
  "reasonCode": string;
  "reason": string;
}

export interface ContextPreviewItem {
  "edgeId": string;
  "nodeId": string;
  "title": string;
  "nodeType": "paragraph" | "outline" | "scene" | "character" | "supplemental_info" | "instruction" | "container";
  "semantic": "must_follow" | "instruction" | "reference" | "can_rewrite" | "style_reference" | "review_basis" | "review_target";
  "estimatedTokens": number;
}

export interface ContextPreviewRequest {
  "project": ProjectFile;
  "targetNodeId": string;
}

export interface ContextPreviewResponse {
  "mode": "paragraph" | "unsupported";
  "items"?: Array<ContextPreviewItem>;
  "excluded"?: Array<ContextPreviewExcluded>;
  "estimatedTokens"?: number;
  "compressionThreshold"?: number;
  "memoryStale"?: boolean;
}

export interface DiscoveredModel {
  "id": string;
  "ownedBy"?: string | null;
}

export interface DraftVersion {
  "id": string;
  "parentId"?: string | null;
  "title": string;
  "body": string;
  "baseBody": string;
  "baseTitle"?: string | null;
  "proposedNodeId"?: string | null;
  "creationSourceNodeIds"?: Array<string>;
  "feedback"?: string;
  "preserve"?: string;
  "rationale"?: string;
  "nodeType": "paragraph" | "outline" | "scene" | "character" | "supplemental_info" | "instruction" | "container";
  "operation"?: "replace" | "create";
  "status"?: "pending" | "accepted" | "rejected" | "rolled_back";
  "targetNodeId"?: string | null;
  "appliedNodeId"?: string | null;
  "appliedNodeSnapshot"?: string | null;
  "conflict"?: string;
  "createdAt": string;
  "referenceNodeIds"?: Array<string>;
  "worldbookEntryIds"?: Array<string>;
}

export interface EdgeMetadata {
  "createdAt": string;
  "updatedAt": string;
  "sourceNodeIds"?: Array<string>;
  "generatedByWorkflow"?: string | null;
  "generatedPlanId"?: string | null;
  "tags"?: Array<string>;
}

export interface HTTPValidationError {
  "detail"?: Array<ValidationError>;
}

export interface HistoryMessage {
  "role": "user" | "assistant";
  "content": string;
}

export interface KnowledgeBaseMetadata {
  "id"?: string;
  "title"?: string;
  "documents"?: Array<KnowledgeDocument>;
  "embeddingModelId"?: string | null;
  "sourceFingerprint"?: string;
  "stale"?: boolean;
  "updatedAt"?: string;
}

export interface KnowledgeDocument {
  "id": string;
  "title": string;
  "sourcePath"?: string | null;
  "tags"?: Array<string>;
  "chunkIds"?: Array<string>;
  "createdAt": string;
  "updatedAt": string;
}

export interface KnowledgeReindexResult {
  "indexedChunks": number;
  "embeddingModelId"?: string | null;
  "unavailableReason"?: string | null;
}

export interface MemoryReindexRequest {
  "project": ProjectFile;
}

export interface ModelListResponse {
  "models"?: Array<DiscoveredModel>;
}

export interface ModelRoutingSettings {
  "structureDerivationModelId"?: string | null;
  "paragraphGenerationModelId"?: string | null;
  "contextCompressionModelId"?: string | null;
  "embeddingModelId"?: string | null;
}

export interface NodeCompletionRequest {
  "project": ProjectFile;
  "targetNodeId": string;
}

export interface NodeMetadata {
  "createdAt": string;
  "updatedAt": string;
  "sourceNodeIds"?: Array<string>;
  "generatedByWorkflow"?: string | null;
  "generatedPlanId"?: string | null;
  "tags"?: Array<string>;
}

export interface NodeWorkbench {
  "title"?: string;
  "draft"?: string;
  "messages"?: Array<WorkbenchMessage>;
  "versions"?: Array<DraftVersion>;
  "activeVersionId"?: string | null;
  "targetNodeIds"?: Array<string>;
  "referenceNodeIds"?: Array<string>;
  "scope"?: "project" | "attached";
  "agentRun"?: AgentRun | null;
  "mutations"?: Array<AgentMutation>;
  "agentPreconditions"?: Record<string, unknown> | null;
}

export interface ParagraphGenerationRequest {
  "project": ProjectFile;
  "targetNodeId": string;
  "mode"?: "replace" | "append";
}

export interface Point {
  "x": number;
  "y": number;
}

export interface ProjectFile {
  "version"?: string;
  "title"?: string;
  "nodes"?: Array<CanvasNode>;
  "edges"?: Array<CanvasEdge>;
  "worldbook"?: Worldbook;
  "createdAt"?: string;
  "updatedAt"?: string;
  "settings"?: ProjectSettings;
  "workbench"?: Record<string, NodeWorkbench>;
  "activeChatId"?: string | null;
}

export interface ProjectSettings {
  "defaultLanguage"?: string;
  "defaultExportMode"?: "assets" | "manuscript";
  "modelRouting"?: ModelRoutingSettings;
  "modelGlobalPrompts"?: Record<string, Record<string, string>>;
}

export interface Proposal {
  "title": string;
  "body": string;
}

export interface ProviderIdRequest {
  "providerId": string;
}

export interface ProviderRegistrationRequest {
  "id": string;
  "name": string;
  "baseUrl": string;
  "apiKey"?: string | null;
  "clearApiKey"?: boolean;
  "headers"?: Record<string, string>;
}

export interface ProviderTestRequest {
  "providerId": string;
  "chatModelId"?: string | null;
  "embeddingModelId"?: string | null;
}

export interface ProviderTestResult {
  "modelListingOk"?: boolean;
  "chatCompletionOk"?: boolean | null;
  "embeddingOk"?: boolean | null;
  "errors"?: Array<string>;
}

export interface PublicAIProviderConfig {
  "id": string;
  "name": string;
  "baseUrl": string;
  "hasApiKey": boolean;
  "headerKeys"?: Array<string>;
}

export interface PublicLocalAppConfig {
  "chatModelId"?: string | null;
  "providers"?: Array<PublicAIProviderConfig>;
  "registeredModels"?: Array<RegisteredModel>;
}

export interface RagPreviewRequest {
  "project": ProjectFile;
  "targetNodeId": string;
  "limit"?: number;
}

export interface RagPreviewResponse {
  "authorized": boolean;
  "authorizingNodeIds"?: Array<string>;
  "snippets"?: Array<RagSnippet>;
  "unavailableReason"?: string | null;
  "stale"?: boolean;
}

export interface RagSnippet {
  "chunkId": string;
  "documentId": string;
  "documentTitle": string;
  "text": string;
  "score": number;
}

export interface RegisterModelRequest {
  "providerId": string;
  "modelId": string;
  "displayName"?: string | null;
  "capabilityTags"?: Array<string>;
  "contextWindowTokens"?: number | null;
  "embeddingDimensions"?: number | null;
}

export interface RegisteredModel {
  "id": string;
  "providerId": string;
  "modelId": string;
  "displayName": string;
  "capabilityTags"?: Array<string>;
  "contextWindowTokens"?: number | null;
  "embeddingDimensions"?: number | null;
  "enabled"?: boolean;
}

export interface SceneStreamRequest {
  "project": ProjectFile;
  "sourceNodeIds": Array<string>;
  "desiredCount": number;
}

export interface Size {
  "width": number;
  "height": number;
}

export interface StructurePlanRequest {
  "project": ProjectFile;
  "workflow": "generate-outline" | "generate-scenes" | "generate-paragraph-tasks" | "generate-next-scene" | "split-scene";
  "sourceNodeIds": Array<string>;
  "desiredCount"?: number | null;
}

export interface TxtExportRequest {
  "project": ProjectFile;
  "nodeIds"?: Array<string>;
  "mode"?: "assets" | "manuscript";
}

export interface ValidationError {
  "loc": Array<string | number>;
  "msg": string;
  "type": string;
  "input"?: unknown;
  "ctx"?: Record<string, unknown>;
}

export interface WorkbenchMessage {
  "id": string;
  "role": "user" | "assistant";
  "content": string;
  "createdAt": string;
  "blocks"?: Array<ChatBlock>;
}

export interface Worldbook {
  "entries"?: Array<WorldbookEntry>;
}

export interface WorldbookEntry {
  "id": string;
  "title": string;
  "content": string;
  "keys"?: Array<string>;
  "tags"?: Array<string>;
  "enabled"?: boolean;
  "alwaysOn"?: boolean;
  "priority"?: number;
  "tokenBudget"?: number | null;
  "insertionPosition"?: "before_context" | "after_context";
}
