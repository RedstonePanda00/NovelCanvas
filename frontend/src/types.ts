export type NodeType =
  | 'paragraph'
  | 'outline'
  | 'scene'
  | 'character'
  | 'supplemental_info'
  | 'instruction'
  | 'review'
  | 'container'
  | 'generic';

export type EdgeSemantic =
  | 'must_follow'
  | 'instruction'
  | 'reference'
  | 'can_rewrite'
  | 'style_reference'
  | 'review_basis'
  | 'review_target';

export type StructureWorkflow =
  | 'generate-outline'
  | 'generate-scenes'
  | 'generate-paragraph-tasks'
  | 'create-review-node';

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface NodeMetadata {
  createdAt: string;
  updatedAt: string;
  sourceNodeIds: string[];
  generatedByWorkflow?: string | null;
  generatedPlanId?: string | null;
  tags: string[];
}

export interface EdgeMetadata {
  createdAt: string;
  updatedAt: string;
  sourceNodeIds: string[];
  generatedByWorkflow?: string | null;
  generatedPlanId?: string | null;
  tags: string[];
}

export interface CanvasNode {
  id: string;
  type: NodeType;
  title: string;
  body?: string | null;
  position: Point;
  size: Size;
  metadata: NodeMetadata;
  outlineLevel?: string | null;
  targetWordCount?: number | null;
  narrativeTask?: string | null;
  childNodeIds: string[];
}

export interface CanvasEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  semantic: EdgeSemantic;
  label?: string | null;
  metadata?: EdgeMetadata | null;
}

export interface ModelRoutingSettings {
  structureDerivationModelId?: string | null;
  paragraphGenerationModelId?: string | null;
  reviewModelId?: string | null;
  contextCompressionModelId?: string | null;
  embeddingModelId?: string | null;
}

export interface ProjectSettings {
  defaultLanguage: string;
  defaultExportMode: 'assets' | 'manuscript';
  modelRouting: ModelRoutingSettings;
}

export interface WorldbookEntry {
  id: string;
  title: string;
  content: string;
  keys: string[];
  tags: string[];
  enabled: boolean;
  alwaysOn: boolean;
  priority: number;
  tokenBudget?: number | null;
  insertionPosition: 'before_context' | 'after_context';
}

export interface Worldbook {
  entries: WorldbookEntry[];
}

export interface ProjectFile {
  version: string;
  title: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  worldbook: Worldbook;
  createdAt: string;
  updatedAt: string;
  settings: ProjectSettings;
}

export interface PublicAIProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  hasApiKey: boolean;
  headerKeys: string[];
}

export interface RegisteredModel {
  id: string;
  providerId: string;
  modelId: string;
  displayName: string;
  capabilityTags: Array<'text' | 'review' | 'structure' | 'compression' | 'embedding' | 'vision'>;
  contextWindowTokens?: number | null;
  embeddingDimensions?: number | null;
  enabled: boolean;
}

export interface PublicLocalAppConfig {
  providers: PublicAIProviderConfig[];
  registeredModels: RegisteredModel[];
}

export interface KnowledgeDocument {
  id: string;
  title: string;
  sourcePath?: string | null;
  tags: string[];
  chunkIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeBaseMetadata {
  id: string;
  title: string;
  documents: KnowledgeDocument[];
  embeddingModelId?: string | null;
  updatedAt: string;
}

export interface KnowledgeReindexResult {
  indexedChunks: number;
  embeddingModelId?: string | null;
  unavailableReason?: string | null;
}

export interface KnowledgeDocumentCreateResponse {
  metadata: KnowledgeBaseMetadata;
  reindex: KnowledgeReindexResult;
}

export interface RagSnippet {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  text: string;
  score: number;
}

export interface RagPreviewResponse {
  authorized: boolean;
  authorizingNodeIds: string[];
  snippets: RagSnippet[];
  unavailableReason?: string | null;
}

export interface AIGenerationPlan {
  id: string;
  workflow: StructureWorkflow;
  sourceNodeIds: string[];
  plannedNodes: CanvasNode[];
  plannedEdges: CanvasEdge[];
  createdAt: string;
  acceptedAt?: string | null;
  rejectedAt?: string | null;
  regeneratedFromPlanId?: string | null;
}
