import type {
  AIGenerationPlan,
  ContextPreviewResponse,
  KnowledgeBaseMetadata,
  KnowledgeReindexResult,
  ProjectFile,
  PublicLocalAppConfig,
  RagPreviewResponse,
  RegisteredModel,
  StructureWorkflow,
  AssistantRequest, AssistantResponse, AssistantContext,
  ChatBlock,
  AgentActivity,
} from './types';

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://127.0.0.1:8000';

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code = 'request_failed',
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function responseError(response: Response): Promise<ApiError> {
  const text = await response.text();
  try {
    const payload = JSON.parse(text) as { detail?: string | { message?: string }; code?: string };
    const detail = typeof payload.detail === 'string' ? payload.detail : payload.detail?.message;
    return new ApiError(detail || `Request failed with ${response.status}`, payload.code ?? 'request_failed', payload);
  } catch {
    return new ApiError(text || `Request failed with ${response.status}`);
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) },
    ...options,
  });
  if (!response.ok) throw await responseError(response);
  return response.json() as Promise<T>;
}

export interface ProviderRegistrationInput {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string | null;
  clearApiKey?: boolean;
  headers: Record<string, string>;
}

export interface DiscoveredModel {
  id: string;
  ownedBy?: string | null;
}

export interface ModelListResponse {
  models: DiscoveredModel[];
}

export interface ProviderTestResult {
  modelListingOk: boolean;
  chatCompletionOk?: boolean | null;
  embeddingOk?: boolean | null;
  errors: string[];
}

export interface RegisterModelInput {
  providerId: string;
  modelId: string;
  displayName?: string | null;
  capabilityTags: RegisteredModel['capabilityTags'];
  contextWindowTokens?: number | null;
  embeddingDimensions?: number | null;
}

type GenerationEvent =
  | { type: 'chunk'; text: string }
  | { type: 'done' }
  | { type: 'error'; error: { code: string; message: string; details?: unknown } };

export async function streamText(
  path: string,
  body: unknown,
  onChunk: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw await responseError(response);

  const reader = response.body?.getReader();
  if (!reader) throw new ApiError('Streaming response body is unavailable.', 'stream_unavailable');

  const decoder = new TextDecoder();
  let buffer = '';
  let completed = false;

  const consumeLine = (line: string) => {
    if (!line.trim()) return;
    let event: GenerationEvent;
    try {
      event = JSON.parse(line) as GenerationEvent;
    } catch {
      throw new ApiError('The generation stream returned invalid data.', 'invalid_stream');
    }
    if (event.type === 'chunk') onChunk(event.text);
    if (event.type === 'done') completed = true;
    if (event.type === 'error') throw new ApiError(event.error.message, event.error.code, event.error.details);
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) consumeLine(line);
    if (done) break;
  }
  if (buffer.trim()) consumeLine(buffer);
  if (!completed) throw new ApiError('The generation stream ended unexpectedly.', 'incomplete_stream');
}

export interface AssistantPreview { reply: string; blocks: ChatBlock[]; edits: ChatBlock[] }
export interface SceneDraft { title: string; body: string }

export async function streamEvents<T extends { type: string }>(path: string, body: unknown, onEvent: (event: T) => void, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`${API_BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!response.ok) throw await responseError(response);
  const reader = response.body?.getReader();
  if (!reader) throw new ApiError('Streaming response body is unavailable.', 'stream_unavailable');
  const decoder = new TextDecoder(); let buffer = ''; let completed = false;
  const stopReading = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', stopReading, { once: true });
  const consume = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as T & { error?: { code: string; message: string } };
    if (event.type === 'error') throw new ApiError(event.error?.message ?? 'Stream failed', event.error?.code);
    onEvent(event);
    if (event.type === 'done') completed = true;
  };
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read(); buffer += decoder.decode(value, { stream: !done });
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const lines = buffer.split('\n'); buffer = lines.pop() ?? ''; lines.forEach(consume);
      if (done || completed) break;
    }
    if (buffer.trim()) consume(buffer);
    if (!completed) throw new ApiError('The stream ended before completion.', 'incomplete_stream');
  } finally { signal?.removeEventListener('abort', stopReading); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export const api = {
  async streamAssistant(input: AssistantRequest, onPreview: (preview: AssistantPreview) => void, signal?: AbortSignal,
    onAgentEvent?: (event: { type: 'activity'; activity: AgentActivity } | { type: 'checkpoint'; checkpoint: Record<string, unknown> }) => void): Promise<AssistantResponse> {
    let result: AssistantResponse | undefined;
    await streamEvents<({ type: 'preview' } & AssistantPreview) | { type: 'done'; response: AssistantResponse } | ({ type: 'activity' } & AgentActivity) | { type: 'checkpoint'; checkpoint: Record<string, unknown> }>('/api/assistant/stream', input, (event) => {
      if (event.type === 'preview') onPreview(event);
      if (event.type === 'done') result = event.response;
      if (event.type === 'activity') onAgentEvent?.({ type: 'activity', activity: event });
      if (event.type === 'checkpoint') onAgentEvent?.(event);
    }, signal);
    if (!result) throw new ApiError('Missing completed response.', 'incomplete_stream');
    return result;
  },
  async streamScenes(project: ProjectFile, sourceNodeIds: string[], desiredCount: number, onPreview: (nodes: SceneDraft[]) => void, signal?: AbortSignal): Promise<SceneDraft[]> {
    let result: SceneDraft[] | undefined;
    await streamEvents<{ type: 'preview' | 'done'; nodes: SceneDraft[] }>('/api/plans/scenes/stream', { project, sourceNodeIds, desiredCount }, (event) => {
      if (event.type === 'preview') onPreview(event.nodes);
      if (event.type === 'done') result = event.nodes;
    }, signal);
    if (!result || result.length !== desiredCount) throw new ApiError('Scene count does not match reserved slots.', 'invalid_stream');
    return result;
  },
  setChatModel: (modelId: string | null) => request<PublicLocalAppConfig>('/api/assistant/model', { method: 'PUT', body: JSON.stringify({ modelId }) }),
  assistantContext: (input: AssistantRequest, signal?: AbortSignal) => request<AssistantContext>('/api/assistant/context', { method: 'POST', body: JSON.stringify(input), signal }),
  runAssistant: (input: AssistantRequest, signal?: AbortSignal) => request<AssistantResponse>('/api/assistant/run', { method: 'POST', body: JSON.stringify(input), signal }),
  getProject: () => request<ProjectFile>('/api/project'),
  saveProject: (project: ProjectFile) => request<ProjectFile>('/api/project', { method: 'PUT', body: JSON.stringify(project) }),
  exportProject: () => request<ProjectFile>('/api/project/export'),
  importProject: (project: unknown) => request<ProjectFile>('/api/project/import', { method: 'POST', body: JSON.stringify(project) }),
  getAppConfig: () => request<PublicLocalAppConfig>('/api/app-config'),
  registerProvider: (input: ProviderRegistrationInput) =>
    request<PublicLocalAppConfig>('/api/providers/register', { method: 'POST', body: JSON.stringify(input) }),
  listProviderModels: (providerId: string) =>
    request<ModelListResponse>('/api/providers/models', { method: 'POST', body: JSON.stringify({ providerId }) }),
  testProvider: (providerId: string, chatModelId?: string, embeddingModelId?: string) =>
    request<ProviderTestResult>('/api/providers/test', {
      method: 'POST',
      body: JSON.stringify({ providerId, chatModelId, embeddingModelId }),
    }),
  registerModel: (input: RegisterModelInput) =>
    request<PublicLocalAppConfig>('/api/models/register', { method: 'POST', body: JSON.stringify(input) }),
  getMemory: (project: ProjectFile) =>
    request<KnowledgeBaseMetadata>('/api/memory', { method: 'POST', body: JSON.stringify({ project }) }),
  reindexMemory: (project: ProjectFile) =>
    request<KnowledgeReindexResult>('/api/memory/reindex', { method: 'POST', body: JSON.stringify({ project }) }),
  previewMemory: (project: ProjectFile, targetNodeId: string, limit = 5) =>
    request<RagPreviewResponse>('/api/memory/preview', {
      method: 'POST',
      body: JSON.stringify({ project, targetNodeId, limit }),
    }),
  previewContext: (project: ProjectFile, targetNodeId: string) =>
    request<ContextPreviewResponse>('/api/context/preview', {
      method: 'POST',
      body: JSON.stringify({ project, targetNodeId }),
    }),
  generateStructurePlan: (
    project: ProjectFile,
    workflow: StructureWorkflow,
    sourceNodeIds: string[],
    desiredCount?: number | null,
    signal?: AbortSignal,
  ) =>
    request<AIGenerationPlan>('/api/plans/structure', {
      method: 'POST',
      body: JSON.stringify({ project, workflow, sourceNodeIds, desiredCount }),
      signal,
    }),
  streamParagraphGeneration: (
    project: ProjectFile,
    targetNodeId: string,
    mode: 'replace' | 'append',
    onChunk: (chunk: string) => void,
    signal?: AbortSignal,
  ) => streamText('/api/generation/paragraph/stream', { project, targetNodeId, mode }, onChunk, signal),
  streamNodeCompletion: (
    project: ProjectFile,
    targetNodeId: string,
    onChunk: (chunk: string) => void,
    signal?: AbortSignal,
  ) => streamText('/api/generation/node-completion/stream', { project, targetNodeId }, onChunk, signal),
  async exportTxt(project: ProjectFile, nodeIds: string[], mode: 'assets' | 'manuscript') {
    const response = await fetch(`${API_BASE}/api/export/txt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project, nodeIds, mode }),
    });
    if (!response.ok) throw await responseError(response);
    return response.text();
  },
};
