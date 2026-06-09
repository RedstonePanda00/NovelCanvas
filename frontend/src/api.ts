import type {
  AIGenerationPlan,
  KnowledgeBaseMetadata,
  KnowledgeDocumentCreateResponse,
  KnowledgeReindexResult,
  ProjectFile,
  PublicLocalAppConfig,
  RagPreviewResponse,
  RegisteredModel,
  StructureWorkflow,
} from './types';

const API_BASE = 'http://127.0.0.1:8000';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers ?? {}),
    },
    ...options,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed with ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export interface ProviderRegistrationInput {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
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

export interface KnowledgeDocumentInput {
  title: string;
  text: string;
  tags: string[];
}

export interface StructurePlanInput {
  workflow: StructureWorkflow;
  sourceNodeIds: string[];
}

export interface ParagraphGenerationInput {
  targetNodeId: string;
  mode: 'replace' | 'append';
}

export interface TxtExportInput {
  nodeIds: string[];
  mode: 'assets' | 'manuscript';
}

export const api = {
  getProject() {
    return request<ProjectFile>('/api/project');
  },
  saveProject(project: ProjectFile) {
    return request<ProjectFile>('/api/project', {
      method: 'PUT',
      body: JSON.stringify(project),
    });
  },
  exportProject() {
    return request<ProjectFile>('/api/project/export');
  },
  importProject(project: unknown) {
    return request<ProjectFile>('/api/project/import', {
      method: 'POST',
      body: JSON.stringify(project),
    });
  },
  getAppConfig() {
    return request<PublicLocalAppConfig>('/api/app-config');
  },
  registerProvider(input: ProviderRegistrationInput) {
    return request<PublicLocalAppConfig>('/api/providers/register', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  listProviderModels(providerId: string) {
    return request<ModelListResponse>('/api/providers/models', {
      method: 'POST',
      body: JSON.stringify({ providerId }),
    });
  },
  testProvider(providerId: string, chatModelId?: string, embeddingModelId?: string) {
    return request<ProviderTestResult>('/api/providers/test', {
      method: 'POST',
      body: JSON.stringify({ providerId, chatModelId, embeddingModelId }),
    });
  },
  registerModel(input: RegisterModelInput) {
    return request<PublicLocalAppConfig>('/api/models/register', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  getKnowledge() {
    return request<KnowledgeBaseMetadata>('/api/knowledge');
  },
  addKnowledgeDocument(input: KnowledgeDocumentInput) {
    return request<KnowledgeDocumentCreateResponse>('/api/knowledge/documents', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  reindexKnowledge() {
    return request<KnowledgeReindexResult>('/api/knowledge/reindex', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },
  previewRag(targetNodeId: string, limit = 5) {
    return request<RagPreviewResponse>('/api/rag/preview', {
      method: 'POST',
      body: JSON.stringify({ targetNodeId, limit }),
    });
  },
  generateStructurePlan(input: StructurePlanInput, signal?: AbortSignal) {
    return request<AIGenerationPlan>('/api/plans/structure', {
      method: 'POST',
      body: JSON.stringify(input),
      signal,
    });
  },
  async streamParagraphGeneration(
    input: ParagraphGenerationInput,
    onChunk: (chunk: string) => void,
    signal?: AbortSignal,
  ) {
    const response = await fetch(`${API_BASE}/api/generation/paragraph/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Request failed with ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Streaming response body is unavailable.');
    }

    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk(decoder.decode(value, { stream: true }));
    }

    const finalChunk = decoder.decode();
    if (finalChunk) onChunk(finalChunk);
  },
  async streamReviewGeneration(
    targetNodeId: string,
    onChunk: (chunk: string) => void,
    signal?: AbortSignal,
  ) {
    const response = await fetch(`${API_BASE}/api/generation/review/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetNodeId }),
      signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Request failed with ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Streaming response body is unavailable.');
    }

    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk(decoder.decode(value, { stream: true }));
    }

    const finalChunk = decoder.decode();
    if (finalChunk) onChunk(finalChunk);
  },
  async streamNodeCompletion(
    targetNodeId: string,
    onChunk: (chunk: string) => void,
    signal?: AbortSignal,
  ) {
    const response = await fetch(`${API_BASE}/api/generation/node-completion/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetNodeId }),
      signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Request failed with ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Streaming response body is unavailable.');
    }

    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk(decoder.decode(value, { stream: true }));
    }

    const finalChunk = decoder.decode();
    if (finalChunk) onChunk(finalChunk);
  },
  async exportTxt(input: TxtExportInput) {
    const response = await fetch(`${API_BASE}/api/export/txt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Request failed with ${response.status}`);
    }

    return response.text();
  },
};
