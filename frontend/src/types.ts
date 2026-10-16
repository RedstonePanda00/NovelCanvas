// Strict domain types used after normalizing the optional request fields in the generated OpenAPI contract.
// Run `npm run generate:api` whenever backend Pydantic models change.
export type NodeType =
  | 'paragraph'
  | 'outline'
  | 'scene'
  | 'character'
  | 'supplemental_info'
  | 'instruction'
  | 'container';

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
  | 'generate-next-scene'
  | 'split-scene';

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
  contextCompressionModelId?: string | null;
  embeddingModelId?: string | null;
}

export interface ProjectSettings {
  defaultLanguage: string;
  defaultExportMode: 'assets' | 'manuscript';
  modelRouting: ModelRoutingSettings;
  modelGlobalPrompts: Record<string, Record<string, string>>;
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
  workbench?: Record<string, NodeWorkbench>;
  activeChatId?: string | null;
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
  capabilityTags: Array<'text' | 'structure' | 'compression' | 'embedding' | 'vision'>;
  contextWindowTokens?: number | null;
  embeddingDimensions?: number | null;
  enabled: boolean;
}

export interface PublicLocalAppConfig {
  chatModelId?: string | null;
  providers: PublicAIProviderConfig[];
  registeredModels: RegisteredModel[];
}

export interface ChatBlock {
  title: string;
  body: string;
}

export interface WorkbenchMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  blocks?: ChatBlock[];
}

export interface DraftVersion {
  id: string;
  parentId?: string | null;
  title: string;
  body: string;
  baseBody: string;
  baseTitle?: string | null;
  proposedNodeId?: string | null;
  creationSourceNodeIds?: string[];
  feedback: string;
  preserve: string;
  rationale: string;
  nodeType: NodeType;
  operation: 'replace' | 'create';
  status: 'pending' | 'accepted' | 'rejected' | 'rolled_back';
  targetNodeId?: string | null;
  appliedNodeId?: string | null;
  appliedNodeSnapshot?: string | null;
  conflict?: string;
  createdAt: string;
  referenceNodeIds?: string[];
  worldbookEntryIds?: string[];
}

export interface NodeWorkbench {
  title?: string;
  draft?: string;
  messages: WorkbenchMessage[];
  versions: DraftVersion[];
  activeVersionId?: string | null;
  targetNodeIds?: string[];
  referenceNodeIds?: string[];
  scope?: 'project' | 'attached';
  agentRun?: AgentRun | null;
  mutations?: AgentMutation[];
  agentPreconditions?: AgentPreconditions | null;
}

export interface AgentMutation {
  id: string;
  kind: 'edge' | 'worldbook' | 'node_delete' | 'node_links';
  targetId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  status: 'pending' | 'accepted' | 'rolled_back';
  conflict?: string;
  createdAt: string;
  index?: number | null;
}

export interface AgentActivity {
  step: number;
  tool: string;
  nodeId?: string | null;
  title?: string | null;
  changedCount: number;
  message?: string;
  total?: number | null;
  nextOffset?: number | null;
  completed?: number;
  planned?: number;
}

export interface AgentRun {
  id: string;
  instruction: string;
  requestMessage: string;
  targetNodeIds: string[];
  referenceNodeIds: string[];
  checkpoint?: Record<string, unknown> | null;
  activities: AgentActivity[];
  status: 'running' | 'paused' | 'failed' | 'completed';
  error?: string;
}

export interface AssistantRequest {
  project: ProjectFile;
  scope?: 'attached' | 'project';
  checkpoint?: Record<string, unknown> | null;
  targetNodeId: string;
  targetNodeIds?: string[];
  referenceNodeIds: string[];
  includeWorldbook: boolean;
  excludedWorldbookIds?: string[];
  action: 'discuss' | 'revise' | 'create' | 'agent';
  message: string;
  preserve?: string;
  baseText?: string;
  outputType?: NodeType;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface AssistantContext {
  nodes: Array<{ id: string; title: string; content: string }>;
  worldbook: Array<{ id: string; title: string; content: string }>;
  relationships?: Array<{ sourceNodeId: string; targetNodeId: string; semantic: string }>;
}

export interface AssistantResponse {
  reply: string;
  blocks?: ChatBlock[];
  proposal?: { title: string; body: string } | null;
  edits?: Array<{ targetNodeId: string; operation: 'replace' | 'create'; title: string; body: string; nodeType: NodeType; baseBody?: string; baseTitle?: string | null; proposedNodeId?: string | null; creationSourceNodeIds?: string[] }>;
  context: AssistantContext;
  coverage?: { projectNodes: number; readNodes: number; planned: number; completed: number };
  mutations?: Array<Pick<AgentMutation, 'kind' | 'targetId' | 'before' | 'after' | 'index'>>;
  preconditions?: AgentPreconditions;
}

export interface AgentPreconditions {
  nodes: Array<Record<string, unknown> & { id: string }>;
  worldbook: Array<Record<string, unknown> & { id: string }>;
  edges?: Array<{ id: string; sourceNodeId: string; targetNodeId: string; semantic: string }> | null;
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
  sourceFingerprint: string;
  stale: boolean;
  updatedAt: string;
}

export interface KnowledgeReindexResult {
  indexedChunks: number;
  embeddingModelId?: string | null;
  unavailableReason?: string | null;
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
  stale: boolean;
}

export interface ContextPreviewItem {
  edgeId: string;
  nodeId: string;
  title: string;
  nodeType: NodeType;
  semantic: EdgeSemantic;
  estimatedTokens: number;
}

export interface ContextPreviewExcluded {
  edgeId: string;
  nodeId?: string | null;
  reasonCode: string;
  reason: string;
}

export interface ContextPreviewResponse {
  mode: 'paragraph' | 'unsupported';
  items: ContextPreviewItem[];
  excluded: ContextPreviewExcluded[];
  estimatedTokens: number;
  compressionThreshold: number;
  memoryStale: boolean;
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
  replacedNodeIds?: string[];
}
