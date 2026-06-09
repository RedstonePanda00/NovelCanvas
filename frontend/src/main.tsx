import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { api, type DiscoveredModel, type ProviderTestResult } from './api';
import type {
  CanvasEdge,
  CanvasNode,
  EdgeSemantic,
  KnowledgeBaseMetadata,
  NodeType,
  Point,
  ProjectFile,
  PublicLocalAppConfig,
  RagPreviewResponse,
  RegisteredModel,
  AIGenerationPlan,
  Size,
  StructureWorkflow,
  WorldbookEntry,
} from './types';
import './styles.css';

const nodeTypes: NodeType[] = [
  'paragraph',
  'outline',
  'scene',
  'character',
  'supplemental_info',
  'instruction',
  'review',
  'container',
  'generic',
];

const edgeSemantics: EdgeSemantic[] = [
  'must_follow',
  'instruction',
  'reference',
  'can_rewrite',
  'style_reference',
  'review_basis',
  'review_target',
];

const capabilityOptions: RegisteredModel['capabilityTags'] = [
  'text',
  'review',
  'structure',
  'compression',
  'embedding',
  'vision',
];

const structureWorkflows: StructureWorkflow[] = [
  'generate-outline',
  'generate-scenes',
  'generate-paragraph-tasks',
  'create-review-node',
];

const paragraphContextOrder: EdgeSemantic[] = [
  'must_follow',
  'instruction',
  'reference',
  'can_rewrite',
  'style_reference',
];

const reviewContextOrder: EdgeSemantic[] = [
  'review_target',
  'review_basis',
  'must_follow',
  'style_reference',
];

const contextSectionLabels: Record<EdgeSemantic, string> = {
  must_follow: 'MUST FOLLOW',
  instruction: 'WRITING TASK',
  reference: 'REFERENCE',
  can_rewrite: 'CAN REWRITE',
  style_reference: 'STYLE REFERENCE',
  review_basis: 'REVIEW BASIS',
  review_target: 'TEXT TO REVIEW',
};

interface ContextPreviewItem {
  edge: CanvasEdge;
  node: CanvasNode;
  estimatedTokens: number;
}

interface ExcludedContextItem {
  edge: CanvasEdge;
  node?: CanvasNode;
  reason: string;
}

interface ContextPreview {
  mode: 'paragraph' | 'review' | 'unsupported';
  items: ContextPreviewItem[];
  excluded: ExcludedContextItem[];
  ragAuthorizers: ContextPreviewItem[];
  estimatedTokens: number;
  compressionThreshold: number;
  compressionNeeded: boolean;
}

interface CanvasViewport {
  x: number;
  y: number;
  scale: number;
}

type CanvasInteraction =
  | {
      kind: 'pan';
      startClient: Point;
      startViewport: CanvasViewport;
    }
  | {
      kind: 'node-drag';
      nodeId: string;
      pending: boolean;
      startClient: Point;
      startPosition: Point;
    }
  | {
      kind: 'node-resize';
      nodeId: string;
      pending: boolean;
      startClient: Point;
      startSize: Size;
    };

type NodeAIAction =
  | 'complete-outline'
  | 'complete-scene'
  | 'generate-scene-paragraph-scaffold'
  | 'generate-paragraph-tasks'
  | 'generate-paragraph'
  | 'generate-review';

const semanticColors: Record<EdgeSemantic, string> = {
  must_follow: '#b42318',
  instruction: '#7c3aed',
  reference: '#2457d6',
  can_rewrite: '#0f7a55',
  style_reference: '#b54708',
  review_basis: '#6b7280',
  review_target: '#be185d',
};

function nowIso() {
  return new Date().toISOString();
}

function createMetadata(tags: string[] = []) {
  const timestamp = nowIso();
  return {
    createdAt: timestamp,
    updatedAt: timestamp,
    sourceNodeIds: [],
    generatedByWorkflow: null,
    generatedPlanId: null,
    tags,
  };
}

function createNode(type: NodeType, index: number, position?: Point): CanvasNode {
  return {
    id: `node-${crypto.randomUUID()}`,
    type,
    title: `New ${type.replace('_', ' ')}`,
    body: '',
    position: position ?? {
      x: 80 + (index % 4) * 280,
      y: 80 + Math.floor(index / 4) * 220,
    },
    size: { width: 220, height: 150 },
    metadata: createMetadata(type === 'supplemental_info' ? ['supplemental-info'] : []),
    outlineLevel: null,
    targetWordCount: null,
    narrativeTask: null,
    childNodeIds: [],
  };
}

function createEdge(sourceNodeId: string, targetNodeId: string, semantic: EdgeSemantic): CanvasEdge {
  const timestamp = nowIso();
  return {
    id: `edge-${crypto.randomUUID()}`,
    sourceNodeId,
    targetNodeId,
    semantic,
    label: semantic,
    metadata: {
      createdAt: timestamp,
      updatedAt: timestamp,
      sourceNodeIds: [],
      generatedByWorkflow: null,
      generatedPlanId: null,
      tags: [],
    },
  };
}

function defaultNodeTypeForWorkflow(workflow: StructureWorkflow): NodeType {
  if (workflow === 'generate-outline') return 'outline';
  if (workflow === 'generate-scenes') return 'scene';
  if (workflow === 'generate-paragraph-tasks') return 'paragraph';
  return 'review';
}

function estimatedPendingNodeCount(workflow: StructureWorkflow) {
  if (workflow === 'generate-scenes') return 3;
  if (workflow === 'generate-paragraph-tasks') return 4;
  return 1;
}

function layoutAnchorForSources(projectData: ProjectFile, sourceNodeIds: string[]) {
  const sourceIdSet = new Set(sourceNodeIds);
  const sourceNodes = projectData.nodes.filter((node) => sourceIdSet.has(node.id));
  return {
    x: Math.max(...sourceNodes.map((node) => node.position.x + node.size.width), 80) + 80,
    y: Math.min(...sourceNodes.map((node) => node.position.y), 80),
  };
}

function layoutPlanNodesRightOfSources<T extends CanvasNode>(
  nodes: T[],
  projectData: ProjectFile,
  sourceNodeIds: string[],
) {
  const anchor = layoutAnchorForSources(projectData, sourceNodeIds);
  return nodes.map((node, index) => ({
    ...node,
    position: {
      x: anchor.x + index * 260,
      y: anchor.y,
    },
  }));
}

function createPlaceholderPlan(
  workflow: StructureWorkflow,
  projectData: ProjectFile,
  sourceNodeIds: string[],
): AIGenerationPlan {
  const planId = `plan-placeholder-${crypto.randomUUID()}`;
  const timestamp = nowIso();
  const nodeType = defaultNodeTypeForWorkflow(workflow);
  const placeholderNodes = Array.from({ length: estimatedPendingNodeCount(workflow) }, (_, index) => ({
    id: `node-placeholder-${crypto.randomUUID()}`,
    type: nodeType,
    title: `Generating ${nodeType.replace('_', ' ')} ${index + 1}`,
    body: '',
    position: { x: 0, y: 0 },
    size: { width: 220, height: 150 },
    metadata: {
      createdAt: timestamp,
      updatedAt: timestamp,
      sourceNodeIds,
      generatedByWorkflow: workflow,
      generatedPlanId: planId,
      tags: ['draft', 'ai', 'generating'],
    },
    outlineLevel: null,
    targetWordCount: null,
    narrativeTask: null,
    childNodeIds: [],
  }));

  return {
    id: planId,
    workflow,
    sourceNodeIds,
    plannedNodes: layoutPlanNodesRightOfSources(placeholderNodes, projectData, sourceNodeIds),
    plannedEdges: [],
    createdAt: timestamp,
  };
}

function createWorldbookEntry(): WorldbookEntry {
  return {
    id: `worldbook-${crypto.randomUUID()}`,
    title: 'New Worldbook Entry',
    content: '',
    keys: [],
    tags: [],
    enabled: true,
    alwaysOn: false,
    priority: 0,
    tokenBudget: null,
    insertionPosition: 'after_context',
  };
}

function parseDelimitedList(value: string) {
  return value
    .split(/[,，、;；\r\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeDelimitedItems(items: string[] = []) {
  return parseDelimitedList(items.join(', '));
}

function characterWorldbookEntryId(nodeId: string) {
  return `worldbook-character-node-${nodeId}`;
}

function characterNodeToWorldbookEntry(node: CanvasNode): WorldbookEntry {
  return {
    id: characterWorldbookEntryId(node.id),
    title: node.title || 'Unnamed Character',
    content: node.body || `Character: ${node.title}`,
    keys: [node.title].map((key) => key.trim()).filter(Boolean),
    tags: Array.from(new Set(['character', 'source-node', `source-node:${node.id}`, ...node.metadata.tags])),
    enabled: true,
    alwaysOn: false,
    priority: 50,
    tokenBudget: null,
    insertionPosition: 'before_context',
  };
}

function parseHeaders(value: string): Record<string, string> {
  if (!value.trim()) return {};
  return JSON.parse(value) as Record<string, string>;
}

function downloadText(filename: string, text: string, type: string) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function estimateTokens(text: string) {
  return Math.ceil(text.length / 4);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function inferModelCapabilities(modelId: string): RegisteredModel['capabilityTags'] {
  const normalized = modelId.toLowerCase();
  if (/\b(embed|embedding|bge|gte|e5|jina-embeddings?)\b/.test(normalized) || normalized.includes('embedding')) {
    return ['embedding'];
  }

  if (normalized.includes('vision') || normalized.includes('vl')) {
    return ['text', 'review', 'structure', 'compression', 'vision'];
  }

  return ['text', 'review', 'structure', 'compression'];
}

function normalizeProject(project: ProjectFile): ProjectFile {
  return {
    ...project,
    worldbook: {
      entries: (project.worldbook?.entries ?? []).map((entry) => ({
        ...entry,
        keys: normalizeDelimitedItems(entry.keys),
        tags: normalizeDelimitedItems(entry.tags),
      })),
    },
    settings: {
      defaultLanguage: project.settings?.defaultLanguage ?? 'en',
      defaultExportMode: project.settings?.defaultExportMode ?? 'assets',
      modelRouting: project.settings?.modelRouting ?? {},
    },
  };
}

function createEmptyProject(title = 'Untitled Novel Canvas Project'): ProjectFile {
  const timestamp = nowIso();
  return {
    version: '0.1.0',
    title,
    nodes: [],
    edges: [],
    worldbook: { entries: [] },
    createdAt: timestamp,
    updatedAt: timestamp,
    settings: {
      defaultLanguage: 'en',
      defaultExportMode: 'assets',
      modelRouting: {},
    },
  };
}

function nodeContextText(node: CanvasNode) {
  return [
    `Title: ${node.title}`,
    `Type: ${node.type}`,
    node.metadata.tags.length ? `Tags: ${node.metadata.tags.join(', ')}` : '',
    node.body ?? '',
  ]
    .filter(Boolean)
    .join('\n');
}

function edgeSortValue(edge: CanvasEdge) {
  return edge.metadata?.createdAt || edge.id;
}

function buildContextPreview(
  project: ProjectFile,
  targetNode: CanvasNode,
  registeredModels: RegisteredModel[],
): ContextPreview {
  const mode = targetNode.type === 'paragraph' ? 'paragraph' : targetNode.type === 'review' ? 'review' : 'unsupported';
  const nodeById = new Map(project.nodes.map((node) => [node.id, node]));
  const incomingEdges = project.edges.filter((edge) => edge.targetNodeId === targetNode.id);
  const items: ContextPreviewItem[] = [];
  const excluded: ExcludedContextItem[] = [];

  for (const edge of incomingEdges) {
    const sourceNode = nodeById.get(edge.sourceNodeId);
    if (!sourceNode) {
      excluded.push({ edge, reason: 'Dangling edge: source node is missing.' });
      continue;
    }

    if (sourceNode.type === 'review') {
      excluded.push({ edge, node: sourceNode, reason: 'Review nodes are never used as generation context.' });
      continue;
    }

    if (mode === 'paragraph') {
      if (edge.semantic === 'review_target' || edge.semantic === 'review_basis') {
        excluded.push({ edge, node: sourceNode, reason: 'Review-only edge semantic is excluded from paragraph context.' });
        continue;
      }

      items.push({ edge, node: sourceNode, estimatedTokens: estimateTokens(nodeContextText(sourceNode)) });
      continue;
    }

    if (mode === 'review') {
      if (!reviewContextOrder.includes(edge.semantic)) {
        excluded.push({ edge, node: sourceNode, reason: 'This edge semantic is not part of review context.' });
        continue;
      }

      items.push({ edge, node: sourceNode, estimatedTokens: estimateTokens(nodeContextText(sourceNode)) });
      continue;
    }

    excluded.push({ edge, node: sourceNode, reason: 'Context preview is only assembled for paragraph or review targets.' });
  }

  const semanticOrder = mode === 'review' ? reviewContextOrder : paragraphContextOrder;
  items.sort((left, right) => {
    const semanticDelta = semanticOrder.indexOf(left.edge.semantic) - semanticOrder.indexOf(right.edge.semantic);
    if (semanticDelta !== 0) return semanticDelta;
    const createdAtDelta = edgeSortValue(left.edge).localeCompare(edgeSortValue(right.edge));
    if (createdAtDelta !== 0) return createdAtDelta;
    return left.edge.id.localeCompare(right.edge.id);
  });

  const modelId =
    mode === 'review'
      ? project.settings.modelRouting.reviewModelId
      : project.settings.modelRouting.paragraphGenerationModelId;
  const model = registeredModels.find((registeredModel) => registeredModel.id === modelId);
  const compressionThreshold = model?.contextWindowTokens
    ? Math.floor(model.contextWindowTokens * 0.75)
    : 12000;
  const estimatedTokens = items.reduce((total, item) => total + item.estimatedTokens, 0);
  const ragAuthorizers =
    mode === 'paragraph'
      ? items.filter(
          (item) =>
            item.edge.semantic === 'reference' &&
            item.node.metadata.tags.includes('supplemental-info'),
        )
      : [];

  return {
    mode,
    items,
    excluded,
    ragAuthorizers,
    estimatedTokens,
    compressionThreshold,
    compressionNeeded: estimatedTokens > compressionThreshold,
  };
}

function App() {
  const [activeView, setActiveView] = useState<'canvas' | 'worldbook' | 'knowledge' | 'export' | 'settings'>('canvas');
  const [project, setProject] = useState<ProjectFile | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [selectedEdgeId, setSelectedEdgeId] = useState('');
  const [newNodeType, setNewNodeType] = useState<NodeType>('paragraph');
  const [edgeSourceId, setEdgeSourceId] = useState('');
  const [edgeTargetId, setEdgeTargetId] = useState('');
  const [edgeSemantic, setEdgeSemantic] = useState<EdgeSemantic>('reference');
  const [canvasViewport, setCanvasViewport] = useState<CanvasViewport>({ x: 24, y: 24, scale: 1 });
  const [connectingEdge, setConnectingEdge] = useState<{ sourceNodeId: string; current: Point } | null>(null);
  const [edgeMenu, setEdgeMenu] = useState<{ edgeId: string; x: number; y: number } | null>(null);
  const canvasStageRef = useRef<HTMLDivElement | null>(null);
  const canvasInteractionRef = useRef<CanvasInteraction | null>(null);
  const [saveState, setSaveState] = useState('Loading project...');
  const lastSavedProjectJsonRef = useRef('');
  const actionMenuCollapsedHeightRef = useRef<Record<string, number>>({});
  const [selectedSourceNodeIds, setSelectedSourceNodeIds] = useState<string[]>([]);
  const [structureWorkflow, setStructureWorkflow] = useState<StructureWorkflow>('generate-outline');
  const [pendingPlan, setPendingPlan] = useState<AIGenerationPlan | null>(null);
  const [pendingPlanGenerating, setPendingPlanGenerating] = useState(false);
  const [planStatus, setPlanStatus] = useState('No pending structure plan.');
  const [generationMode, setGenerationMode] = useState<'replace' | 'append'>('replace');
  const [generationTargetNodeId, setGenerationTargetNodeId] = useState('');
  const [generationStatus, setGenerationStatus] = useState('No active AI generation.');
  const [pendingNodeCompletions, setPendingNodeCompletions] = useState<Record<string, string>>({});
  const generationAbortRef = useRef<AbortController | null>(null);
  const [exportNodeIds, setExportNodeIds] = useState<string[]>([]);
  const [exportMode, setExportMode] = useState<'assets' | 'manuscript'>('assets');
  const [exportStatus, setExportStatus] = useState('No export has run yet.');

  const [config, setConfig] = useState<PublicLocalAppConfig>({ providers: [], registeredModels: [] });
  const [providerId, setProviderId] = useState('siliconflow');
  const [providerName, setProviderName] = useState('SiliconFlow');
  const [baseUrl, setBaseUrl] = useState('https://api.siliconflow.cn/v1');
  const [apiKey, setApiKey] = useState('');
  const [headersJson, setHeadersJson] = useState('');
  const [selectedProviderId, setSelectedProviderId] = useState('');
  const [models, setModels] = useState<DiscoveredModel[]>([]);
  const [selectedModelId, setSelectedModelId] = useState('');
  const [selectedCapabilities, setSelectedCapabilities] = useState<RegisteredModel['capabilityTags']>(['text']);
  const [contextWindowTokens, setContextWindowTokens] = useState('');
  const [embeddingDimensions, setEmbeddingDimensions] = useState('');
  const [testResult, setTestResult] = useState<ProviderTestResult | null>(null);
  const [status, setStatus] = useState('Loading settings...');
  const [knowledge, setKnowledge] = useState<KnowledgeBaseMetadata | null>(null);
  const [knowledgeTitle, setKnowledgeTitle] = useState('');
  const [knowledgeTags, setKnowledgeTags] = useState('');
  const [knowledgeText, setKnowledgeText] = useState('');
  const [knowledgeStatus, setKnowledgeStatus] = useState('Loading knowledge base...');
  const [worldbookStatus, setWorldbookStatus] = useState('Worldbook entries are saved with the project.');
  const [expandedWorldbookEntryIds, setExpandedWorldbookEntryIds] = useState<string[]>([]);
  const [ragPreview, setRagPreview] = useState<RagPreviewResponse | null>(null);
  const [ragStatus, setRagStatus] = useState('');

  const isGenerating = Boolean(generationTargetNodeId);

  useEffect(() => {
    Promise.all([api.getAppConfig(), api.getKnowledge()])
      .then(([configData, knowledgeData]) => {
        setConfig(configData);
        setSelectedProviderId(configData.providers[0]?.id ?? '');
        setKnowledge(knowledgeData);
        setSaveState('Choose a project to begin.');
        setStatus('Settings loaded.');
        setKnowledgeStatus('Knowledge base loaded.');
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Failed to load app data.';
        setSaveState(message);
        setStatus(message);
        setKnowledgeStatus(message);
      });
  }, []);

  useEffect(() => {
    if (!project) return;
    const snapshot = JSON.stringify(project);
    if (snapshot === lastSavedProjectJsonRef.current) return;

    setSaveState('Autosave pending...');
    const timeoutId = window.setTimeout(() => {
      saveProject(project, 'Autosaved.');
    }, 800);

    return () => window.clearTimeout(timeoutId);
  }, [project]);

  useEffect(() => {
    if (activeView !== 'canvas') return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [activeView]);

  const selectedNode = useMemo(
    () => project?.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [project?.nodes, selectedNodeId],
  );

  const selectedEdge = useMemo(
    () => project?.edges.find((edge) => edge.id === selectedEdgeId) ?? null,
    [project?.edges, selectedEdgeId],
  );

  const incomingHighlightByNodeId = useMemo(() => {
    const map = new Map<string, EdgeSemantic>();
    if (!project || !selectedNodeId) return map;
    for (const edge of project.edges) {
      if (edge.targetNodeId === selectedNodeId) {
        map.set(edge.sourceNodeId, edge.semantic);
      }
    }
    return map;
  }, [project, selectedNodeId]);

  const incomingHighlightEdgeIds = useMemo(() => {
    if (!project || !selectedNodeId) return new Set<string>();
    return new Set(project.edges.filter((edge) => edge.targetNodeId === selectedNodeId).map((edge) => edge.id));
  }, [project, selectedNodeId]);

  const contextPreview = useMemo(
    () => (project && selectedNode ? buildContextPreview(project, selectedNode, config.registeredModels) : null),
    [config.registeredModels, project, selectedNode],
  );

  const canvasNodes = useMemo(
    () => [...(project?.nodes ?? []), ...(pendingPlan?.plannedNodes ?? [])],
    [pendingPlan?.plannedNodes, project?.nodes],
  );

  const canvasEdges = useMemo(
    () => [...(project?.edges ?? []), ...(pendingPlan?.plannedEdges ?? [])],
    [pendingPlan?.plannedEdges, project?.edges],
  );

  useEffect(() => {
    if (!selectedModelId) return;
    setSelectedCapabilities(inferModelCapabilities(selectedModelId));
  }, [selectedModelId]);

  const selectedProvider = useMemo(
    () => config.providers.find((provider) => provider.id === selectedProviderId),
    [config.providers, selectedProviderId],
  );

  useEffect(() => {
    function handlePointerMove(event: PointerEvent) {
      const interaction = canvasInteractionRef.current;
      if (!interaction) {
        if (connectingEdge) {
          setConnectingEdge((current) => (current ? { ...current, current: screenToCanvas(event.clientX, event.clientY) } : null));
        }
        return;
      }

      if (interaction.kind === 'pan') {
        setCanvasViewport({
          ...interaction.startViewport,
          x: interaction.startViewport.x + event.clientX - interaction.startClient.x,
          y: interaction.startViewport.y + event.clientY - interaction.startClient.y,
        });
        return;
      }

      if (interaction.kind === 'node-drag') {
        updateNodePosition(interaction.nodeId, interaction.pending, {
          x: interaction.startPosition.x + (event.clientX - interaction.startClient.x) / canvasViewport.scale,
          y: interaction.startPosition.y + (event.clientY - interaction.startClient.y) / canvasViewport.scale,
        });
        return;
      }

      if (interaction.kind === 'node-resize') {
        updateNodeSize(interaction.nodeId, interaction.pending, {
          width: interaction.startSize.width + (event.clientX - interaction.startClient.x) / canvasViewport.scale,
          height: interaction.startSize.height + (event.clientY - interaction.startClient.y) / canvasViewport.scale,
        });
      }
    }

    function handlePointerUp(event: PointerEvent) {
      canvasInteractionRef.current = null;
      if (!connectingEdge) return;

      const targetNode = findCanvasNodeAt(screenToCanvas(event.clientX, event.clientY), connectingEdge.sourceNodeId);
      if (targetNode) {
        createCanvasEdge(connectingEdge.sourceNodeId, targetNode.id);
      }
      setConnectingEdge(null);
    }

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [canvasViewport, connectingEdge, project, pendingPlan]);

  async function saveProject(projectToSave = project, successMessage = 'Saved.') {
    if (!projectToSave) return;
    setSaveState('Saving...');

    try {
      const savedProject = await api.saveProject(projectToSave);
      const savedProjectJson = JSON.stringify(savedProject);
      lastSavedProjectJsonRef.current = savedProjectJson;
      setProject((current) => (current && JSON.stringify(current) === savedProjectJson ? current : savedProject));
      setSaveState(successMessage);
    } catch (error: unknown) {
      setSaveState(error instanceof Error ? error.message : 'Save failed.');
    }
  }

  function openProject(projectData: ProjectFile, message: string) {
    const normalizedProject = normalizeProject(projectData);
    setProject(normalizedProject);
    lastSavedProjectJsonRef.current = JSON.stringify(normalizedProject);
    setSelectedNodeId(normalizedProject.nodes[0]?.id ?? '');
    setSelectedEdgeId('');
    setExportNodeIds([]);
    setPendingPlan(null);
    setPendingPlanGenerating(false);
    setConnectingEdge(null);
    setEdgeMenu(null);
    setActiveView('canvas');
    setSaveState(message);
  }

  async function loadStoredProject(confirmReplace = Boolean(project)) {
    if (confirmReplace && !window.confirm('Load the saved project and replace the current canvas?')) return;
    setSaveState('Reading project...');

    try {
      const projectData = await api.getProject();
      openProject(projectData, 'Project loaded.');
    } catch (error: unknown) {
      setSaveState(error instanceof Error ? error.message : 'Project load failed.');
    }
  }

  async function createNewProject() {
    if (project && !window.confirm('Create a new project and replace the current canvas?')) return;
    const title = window.prompt('Project title', 'Untitled Novel Canvas Project');
    if (title === null) return;

    const draftProject = createEmptyProject(title.trim() || 'Untitled Novel Canvas Project');
    setSaveState('Creating project...');

    try {
      const savedProject = await api.saveProject(draftProject);
      openProject(savedProject, 'New project created.');
    } catch (error: unknown) {
      setSaveState(error instanceof Error ? error.message : 'Project creation failed.');
    }
  }

  function updateProject(updater: (current: ProjectFile) => ProjectFile) {
    setProject((current) => {
      if (!current) return current;
      const nextProject = updater(current);
      return { ...nextProject, updatedAt: nowIso() };
    });
  }

  function screenToCanvas(clientX: number, clientY: number): Point {
    const stage = canvasStageRef.current;
    if (!stage) return { x: 0, y: 0 };
    const rect = stage.getBoundingClientRect();
    return {
      x: (clientX - rect.left - canvasViewport.x) / canvasViewport.scale,
      y: (clientY - rect.top - canvasViewport.y) / canvasViewport.scale,
    };
  }

  function updateCanvasNode(nodeId: string, pending: boolean, updater: (node: CanvasNode) => CanvasNode) {
    if (pending) {
      setPendingPlan((current) =>
        current
          ? {
              ...current,
              plannedNodes: current.plannedNodes.map((node) => (node.id === nodeId ? updater(node) : node)),
            }
          : current,
      );
      return;
    }

    updateProject((current) => ({
      ...current,
      nodes: current.nodes.map((node) => (node.id === nodeId ? updater(node) : node)),
    }));
  }

  function updateNodePosition(nodeId: string, pending: boolean, position: Point) {
    updateCanvasNode(nodeId, pending, (node) => ({
      ...node,
      position,
      metadata: { ...node.metadata, updatedAt: nowIso() },
    }));
  }

  function updateNodeSize(nodeId: string, pending: boolean, size: Size) {
    updateCanvasNode(nodeId, pending, (node) => ({
      ...node,
      size: {
        width: clamp(size.width, 180, 560),
        height: clamp(size.height, 120, 640),
      },
      metadata: { ...node.metadata, updatedAt: nowIso() },
    }));
  }

  function handleActionMenuToggle(event: React.SyntheticEvent<HTMLDetailsElement>, node: CanvasNode) {
    const details = event.currentTarget;
    if (details.open) {
      actionMenuCollapsedHeightRef.current[node.id] ??= node.size.height;
      window.requestAnimationFrame(() => {
        const article = details.closest<HTMLElement>('.canvas-node');
        if (!article) return;
        const nextHeight = Math.ceil(article.scrollHeight + 4);
        if (nextHeight > node.size.height) {
          updateNodeSize(node.id, false, { ...node.size, height: nextHeight });
        }
      });
      return;
    }

    const collapsedHeight = actionMenuCollapsedHeightRef.current[node.id];
    delete actionMenuCollapsedHeightRef.current[node.id];
    if (collapsedHeight !== undefined && collapsedHeight < node.size.height) {
      updateNodeSize(node.id, false, { ...node.size, height: collapsedHeight });
    }
  }

  function updateNodeFromCanvas(nodeId: string, changes: Partial<CanvasNode>) {
    updateCanvasNode(nodeId, false, (node) => ({
      ...node,
      ...changes,
      metadata: { ...(changes.metadata ?? node.metadata), updatedAt: nowIso() },
    }));
  }

  function findCanvasNodeAt(point: Point, excludedNodeId = '') {
    return [...canvasNodes]
      .reverse()
      .find(
        (node) =>
          node.id !== excludedNodeId &&
          point.x >= node.position.x &&
          point.x <= node.position.x + node.size.width &&
          point.y >= node.position.y &&
          point.y <= node.position.y + node.size.height,
      ) ?? null;
  }

  function getIncomingNodes(nodeId: string, semantic?: EdgeSemantic) {
    if (!project) return [];
    const nodeById = new Map(project.nodes.map((node) => [node.id, node]));
    return project.edges
      .filter((edge) => edge.targetNodeId === nodeId && (!semantic || edge.semantic === semantic))
      .map((edge) => nodeById.get(edge.sourceNodeId))
      .filter((node): node is CanvasNode => Boolean(node));
  }

  function getReferenceSourceIds(nodeId: string) {
    return getIncomingNodes(nodeId, 'reference').map((node) => node.id);
  }

  function getScaffoldSourceIds(node: CanvasNode) {
    return Array.from(new Set([node.id, ...getReferenceSourceIds(node.id)]));
  }

  function upsertCharacterSourcesIntoWorldbook(projectData: ProjectFile, sourceNodeIds: string[]) {
    const sourceIdSet = new Set(sourceNodeIds);
    const characterNodes = projectData.nodes.filter((node) => sourceIdSet.has(node.id) && node.type === 'character');
    if (!characterNodes.length) return projectData;

    const entriesById = new Map((projectData.worldbook?.entries ?? []).map((entry) => [entry.id, entry]));
    const existingOrder = (projectData.worldbook?.entries ?? []).map((entry) => entry.id);
    const characterEntryIds = characterNodes.map((node) => characterWorldbookEntryId(node.id));
    for (const node of characterNodes) {
      entriesById.set(characterWorldbookEntryId(node.id), characterNodeToWorldbookEntry(node));
    }

    const orderedIds = [
      ...existingOrder,
      ...characterEntryIds.filter((entryId) => !existingOrder.includes(entryId)),
    ];

    return {
      ...projectData,
      worldbook: {
        entries: orderedIds
          .map((entryId) => entriesById.get(entryId))
          .filter((entry): entry is WorldbookEntry => Boolean(entry)),
      },
    };
  }

  function hasIncomingReference(nodeId: string) {
    return getReferenceSourceIds(nodeId).length > 0;
  }

  function centerNodeInCanvas(node: CanvasNode) {
    const stage = canvasStageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    setCanvasViewport((current) => ({
      ...current,
      x: rect.width / 2 - (node.position.x + node.size.width / 2) * current.scale,
      y: rect.height / 2 - (node.position.y + node.size.height / 2) * current.scale,
    }));
    setSelectedNodeId(node.id);
    setSelectedEdgeId('');
    setEdgeMenu(null);
  }

  function handleViewportWheel(event: React.WheelEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    const stage = canvasStageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const nextScale = clamp(canvasViewport.scale * (event.deltaY > 0 ? 0.92 : 1.08), 0.3, 2.2);
    const canvasPoint = screenToCanvas(event.clientX, event.clientY);
    setCanvasViewport({
      x: event.clientX - rect.left - canvasPoint.x * nextScale,
      y: event.clientY - rect.top - canvasPoint.y * nextScale,
      scale: nextScale,
    });
  }

  function addNodeAt(type: NodeType, position: Point) {
    if (!project || isGenerating) return;
    const node = createNode(type, project.nodes.length, position);
    updateProject((current) => ({ ...current, nodes: [...current.nodes, node] }));
    setSelectedNodeId(node.id);
    setSelectedEdgeId('');
  }

  function updateSelectedNode(changes: Partial<CanvasNode>) {
    if (!selectedNode) return;
    updateProject((current) => ({
      ...current,
      nodes: current.nodes.map((node) =>
        node.id === selectedNode.id
          ? { ...node, ...changes, metadata: { ...(changes.metadata ?? node.metadata), updatedAt: nowIso() } }
          : node,
      ),
    }));
  }

  function updateSelectedNodeTags(value: string) {
    updateSelectedNode({
      metadata: {
        ...selectedNode!.metadata,
        tags: value
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
        updatedAt: nowIso(),
      },
    });
  }

  function updateNodeBody(nodeId: string, body: string) {
    updateProject((current) => ({
      ...current,
      nodes: current.nodes.map((node) =>
        node.id === nodeId
          ? { ...node, body, metadata: { ...node.metadata, updatedAt: nowIso() } }
          : node,
      ),
    }));
  }

  async function generateParagraphForNode(node: CanvasNode) {
    if (!project || node.type !== 'paragraph') {
      setGenerationStatus('Select a paragraph node first.');
      return;
    }

    await saveProject(project, 'Saved before generation.');

    const controller = new AbortController();
    generationAbortRef.current = controller;
    setGenerationTargetNodeId(node.id);
    setGenerationStatus('Generating paragraph...');

    let nextBody = '';
    setPendingNodeCompletions((current) => ({ ...current, [node.id]: nextBody }));

    try {
      await api.streamParagraphGeneration(
        { targetNodeId: node.id, mode: generationMode },
        (chunk) => {
          nextBody += chunk;
          setPendingNodeCompletions((current) => ({ ...current, [node.id]: nextBody }));
        },
        controller.signal,
      );
      setGenerationStatus('Paragraph generation completed. Accept or reject the pending preview.');
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setGenerationStatus('Paragraph generation canceled. Written text was kept.');
      } else {
        setGenerationStatus(error instanceof Error ? error.message : 'Paragraph generation failed.');
      }
    } finally {
      generationAbortRef.current = null;
      setGenerationTargetNodeId('');
    }
  }

  async function generateParagraph() {
    if (!selectedNode) {
      setGenerationStatus('Select a paragraph node first.');
      return;
    }
    await generateParagraphForNode(selectedNode);
  }

  function cancelParagraphGeneration() {
    generationAbortRef.current?.abort();
  }

  async function completeStructureNode(node: CanvasNode) {
    if (!project || (node.type !== 'outline' && node.type !== 'scene')) {
      setGenerationStatus('Select an outline or scene node first.');
      return;
    }
    if (!hasIncomingReference(node.id)) {
      setGenerationStatus('Current-node completion requires at least one incoming reference node.');
      return;
    }

    const sourceIds = getReferenceSourceIds(node.id);
    const projectWithWorldbook = upsertCharacterSourcesIntoWorldbook(project, sourceIds);
    if (projectWithWorldbook !== project) {
      setProject(projectWithWorldbook);
      setWorldbookStatus('Character reference imported into Worldbook.');
    }
    await saveProject(projectWithWorldbook, 'Saved before node completion.');

    const controller = new AbortController();
    generationAbortRef.current = controller;
    setGenerationTargetNodeId(node.id);
    setGenerationStatus(`Completing ${node.type}...`);

    let nextBody = '';
    setPendingNodeCompletions((current) => ({ ...current, [node.id]: nextBody }));

    try {
      await api.streamNodeCompletion(
        node.id,
        (chunk) => {
          nextBody += chunk;
          setPendingNodeCompletions((current) => ({ ...current, [node.id]: nextBody }));
        },
        controller.signal,
      );
      setGenerationStatus(`${node.type} completion finished. Accept or reject the pending preview.`);
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setGenerationStatus(`${node.type} completion canceled. Pending text was kept.`);
      } else {
        setGenerationStatus(error instanceof Error ? error.message : `${node.type} completion failed.`);
      }
    } finally {
      generationAbortRef.current = null;
      setGenerationTargetNodeId('');
    }
  }

  async function generateReviewForNode(node: CanvasNode) {
    if (!project || node.type !== 'review') {
      setGenerationStatus('Select a review node first.');
      return;
    }

    await saveProject(project, 'Saved before review generation.');

    const controller = new AbortController();
    generationAbortRef.current = controller;
    setGenerationTargetNodeId(node.id);
    setGenerationStatus('Generating review...');

    let nextBody = '';
    setPendingNodeCompletions((current) => ({ ...current, [node.id]: nextBody }));

    try {
      await api.streamReviewGeneration(
        node.id,
        (chunk) => {
          nextBody += chunk;
          setPendingNodeCompletions((current) => ({ ...current, [node.id]: nextBody }));
        },
        controller.signal,
      );
      setGenerationStatus('Review generation completed. Accept or reject the pending preview.');
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setGenerationStatus('Review generation canceled. Written text was kept.');
      } else {
        setGenerationStatus(error instanceof Error ? error.message : 'Review generation failed.');
      }
    } finally {
      generationAbortRef.current = null;
      setGenerationTargetNodeId('');
    }
  }

  async function generateReview() {
    if (!selectedNode) {
      setGenerationStatus('Select a review node first.');
      return;
    }
    await generateReviewForNode(selectedNode);
  }

  function acceptNodeCompletion(node: CanvasNode) {
    const pendingText = pendingNodeCompletions[node.id];
    if (pendingText === undefined) return;
    const separator = generationMode === 'append' && node.type === 'paragraph' && node.body?.trim() ? '\n\n' : '';
    const nextBody =
      node.type === 'paragraph' && generationMode === 'append'
        ? `${node.body ?? ''}${separator}${pendingText}`
        : pendingText;
    updateNodeBody(node.id, nextBody);
    setPendingNodeCompletions((current) => {
      const next = { ...current };
      delete next[node.id];
      return next;
    });
    setGenerationStatus('Pending preview accepted.');
  }

  function rejectNodeCompletion(nodeId: string) {
    setPendingNodeCompletions((current) => {
      const next = { ...current };
      delete next[nodeId];
      return next;
    });
    setGenerationStatus('Pending preview rejected.');
  }

  function deleteSelectedNode() {
    if (!selectedNode) return;
    deleteSelectedNodeById(selectedNode.id);
  }

  function deleteSelectedNodeById(nodeId: string) {
    const nodeToDelete = project?.nodes.find((node) => node.id === nodeId);
    if (!nodeToDelete) return;
    if (nodeToDelete.body?.trim()) {
      const confirmed = window.confirm('This node has body content. Delete it and all connected edges?');
      if (!confirmed) return;
    }

    updateProject((current) => ({
      ...current,
      nodes: current.nodes
        .filter((node) => node.id !== nodeToDelete.id)
        .map((node) => ({
          ...node,
          childNodeIds: node.childNodeIds.filter((childNodeId) => childNodeId !== nodeToDelete.id),
        })),
      edges: current.edges.filter(
        (edge) => edge.sourceNodeId !== nodeToDelete.id && edge.targetNodeId !== nodeToDelete.id,
      ),
    }));
    setSelectedNodeId('');
    setSelectedEdgeId('');
    setEdgeMenu(null);
  }

  function addEdge() {
    if (!edgeSourceId || !edgeTargetId || edgeSourceId === edgeTargetId) return;
    const edge = createEdge(edgeSourceId, edgeTargetId, edgeSemantic);
    updateProject((current) => ({
      ...current,
      edges: [...current.edges, edge],
    }));
    setSelectedEdgeId(edge.id);
    setSelectedNodeId('');
  }

  function createCanvasEdge(sourceNodeId: string, targetNodeId: string) {
    if (!project || sourceNodeId === targetNodeId || isGenerating) return;
    const existingEdge = project.edges.find(
      (edge) => edge.sourceNodeId === sourceNodeId && edge.targetNodeId === targetNodeId,
    );
    if (existingEdge) {
      setSelectedEdgeId(existingEdge.id);
      setSelectedNodeId('');
      return;
    }

    const edge = createEdge(sourceNodeId, targetNodeId, 'reference');
    updateProject((current) => ({ ...current, edges: [...current.edges, edge] }));
    setSelectedEdgeId(edge.id);
    setSelectedNodeId('');
  }

  function updateEdgeSemantic(edgeId: string, semantic: EdgeSemantic) {
    updateProject((current) => ({
      ...current,
      edges: current.edges.map((edge) =>
        edge.id === edgeId
          ? {
              ...edge,
              semantic,
              label: semantic,
              metadata: edge.metadata ? { ...edge.metadata, updatedAt: nowIso() } : edge.metadata,
            }
          : edge,
      ),
    }));
  }

  function toggleSourceNode(nodeId: string) {
    setSelectedSourceNodeIds((current) =>
      current.includes(nodeId) ? current.filter((id) => id !== nodeId) : [...current, nodeId],
    );
  }

  function toggleExportNode(nodeId: string) {
    setExportNodeIds((current) =>
      current.includes(nodeId) ? current.filter((id) => id !== nodeId) : [...current, nodeId],
    );
  }

  function selectAllExportNodes() {
    if (!project) return;
    setExportNodeIds(project.nodes.map((node) => node.id));
  }

  async function exportTxt() {
    if (!project) return;
    setExportStatus('Exporting TXT...');

    try {
      await saveProject(project, 'Saved before TXT export.');
      const text = await api.exportTxt({
        nodeIds: exportNodeIds,
        mode: exportMode,
      });
      downloadText(
        `${project.title || 'novel-canvas'}-${exportMode}.txt`,
        text,
        'text/plain;charset=utf-8',
      );
      setExportStatus(`TXT exported as ${exportMode}.`);
    } catch (error: unknown) {
      setExportStatus(error instanceof Error ? error.message : 'TXT export failed.');
    }
  }

  async function exportProjectJson() {
    if (!project) return;
    setExportStatus('Exporting project JSON...');

    try {
      await saveProject(project, 'Saved before JSON export.');
      const exportedProject = await api.exportProject();
      downloadText(
        `${exportedProject.title || 'project'}.json`,
        JSON.stringify(exportedProject, null, 2),
        'application/json;charset=utf-8',
      );
      setExportStatus('Project JSON exported.');
      setSaveState('Project JSON saved as file.');
    } catch (error: unknown) {
      setExportStatus(error instanceof Error ? error.message : 'Project JSON export failed.');
      setSaveState(error instanceof Error ? error.message : 'Project JSON export failed.');
    }
  }

  async function importProjectJson(file: File | null) {
    if (!file) return;
    setExportStatus('Importing project JSON...');

    try {
      const text = await file.text();
      const data = JSON.parse(text) as unknown;
      const importedProject = normalizeProject(await api.importProject(data));
      openProject(importedProject, 'Project JSON loaded.');
      setExportStatus('Project JSON imported.');
    } catch (error: unknown) {
      setExportStatus(error instanceof Error ? error.message : 'Project JSON import failed.');
      setSaveState(error instanceof Error ? error.message : 'Project JSON import failed.');
    }
  }

  function addWorldbookEntry() {
    const entry = createWorldbookEntry();
    updateProject((current) => ({
      ...current,
      worldbook: {
        entries: [...(current.worldbook?.entries ?? []), entry],
      },
    }));
    setExpandedWorldbookEntryIds((current) => [...current.filter((entryId) => entryId !== entry.id), entry.id]);
    setWorldbookStatus('Worldbook entry added.');
  }

  function updateWorldbookEntry(entryId: string, changes: Partial<WorldbookEntry>) {
    updateProject((current) => ({
      ...current,
      worldbook: {
        entries: (current.worldbook?.entries ?? []).map((entry) =>
          entry.id === entryId ? { ...entry, ...changes } : entry,
        ),
      },
    }));
  }

  function deleteWorldbookEntry(entryId: string) {
    updateProject((current) => ({
      ...current,
      worldbook: {
        entries: (current.worldbook?.entries ?? []).filter((entry) => entry.id !== entryId),
      },
    }));
    setExpandedWorldbookEntryIds((current) => current.filter((id) => id !== entryId));
    setWorldbookStatus('Worldbook entry deleted.');
  }

  function toggleWorldbookEntry(entryId: string) {
    setExpandedWorldbookEntryIds((current) =>
      current.includes(entryId) ? current.filter((id) => id !== entryId) : [...current, entryId],
    );
  }

  function exportWorldbookJson() {
    if (!project) return;
    downloadText(
      `${project.title || 'novel-canvas'}-worldbook.json`,
      JSON.stringify(project.worldbook ?? { entries: [] }, null, 2),
      'application/json;charset=utf-8',
    );
    setWorldbookStatus('Worldbook JSON exported.');
  }

  async function importWorldbookJson(file: File | null) {
    if (!file) return;
    try {
      const text = await file.text();
      const payload = JSON.parse(text) as { entries?: WorldbookEntry[] } | WorldbookEntry[];
      const entries = Array.isArray(payload) ? payload : payload.entries;
      if (!Array.isArray(entries)) {
        throw new Error('Worldbook JSON must be an array or an object with entries.');
      }
      updateProject((current) => ({
        ...current,
        worldbook: {
          entries: entries.map((entry) => ({
            ...createWorldbookEntry(),
            ...entry,
            id: entry.id || `worldbook-${crypto.randomUUID()}`,
            keys: Array.isArray(entry.keys) ? normalizeDelimitedItems(entry.keys) : [],
            tags: Array.isArray(entry.tags) ? normalizeDelimitedItems(entry.tags) : [],
            enabled: entry.enabled ?? true,
            alwaysOn: entry.alwaysOn ?? false,
            priority: Number(entry.priority ?? 0),
            tokenBudget: entry.tokenBudget === undefined ? null : entry.tokenBudget,
            insertionPosition:
              entry.insertionPosition === 'before_context' ? 'before_context' : 'after_context',
          })),
        },
      }));
      setWorldbookStatus(`Imported ${entries.length} worldbook entr${entries.length === 1 ? 'y' : 'ies'}.`);
    } catch (error: unknown) {
      setWorldbookStatus(error instanceof Error ? error.message : 'Worldbook import failed.');
    }
  }

  async function generateStructurePlan(workflowOverride?: StructureWorkflow, sourceNodeIdsOverride?: string[]) {
    const sourceIds = sourceNodeIdsOverride ?? selectedSourceNodeIds;
    const workflow = workflowOverride ?? structureWorkflow;
    if (!project || !sourceIds.length) {
      setPlanStatus('Select at least one source node.');
      return;
    }

    const projectWithWorldbook = upsertCharacterSourcesIntoWorldbook(project, sourceIds);
    if (projectWithWorldbook !== project) {
      setProject(projectWithWorldbook);
      setWorldbookStatus('Character reference imported into Worldbook.');
    }

    const placeholderPlan = createPlaceholderPlan(workflow, projectWithWorldbook, sourceIds);
    const controller = new AbortController();
    generationAbortRef.current = controller;
    setGenerationTargetNodeId(sourceIds[0]);
    setPendingPlan(placeholderPlan);
    setPendingPlanGenerating(true);
    setSelectedNodeId(placeholderPlan.plannedNodes[0]?.id ?? selectedNodeId);
    setSelectedEdgeId('');
    setEdgeMenu(null);
    setPlanStatus('Saving project before planning...');

    try {
      await saveProject(projectWithWorldbook, 'Saved before planning.');
      setPlanStatus('Generating pending plan...');
      const plan = await api.generateStructurePlan(
        {
          workflow,
          sourceNodeIds: sourceIds,
        },
        controller.signal,
      );
      setPendingPlan({
        ...plan,
        plannedNodes: layoutPlanNodesRightOfSources(plan.plannedNodes, projectWithWorldbook, sourceIds),
      });
      setSelectedNodeId(plan.plannedNodes[0]?.id ?? selectedNodeId);
      setPlanStatus(`Pending plan ready: ${plan.plannedNodes.length} node(s), ${plan.plannedEdges.length} edge(s).`);
    } catch (error: unknown) {
      setPendingPlan(null);
      if (error instanceof DOMException && error.name === 'AbortError') {
        setPlanStatus('Structure plan generation canceled.');
      } else {
        setPlanStatus(error instanceof Error ? error.message : 'Failed to generate structure plan.');
      }
    } finally {
      generationAbortRef.current = null;
      setGenerationTargetNodeId('');
      setPendingPlanGenerating(false);
    }
  }

  function generateScaffoldFromNode(node: CanvasNode, workflow: StructureWorkflow) {
    void generateStructurePlan(workflow, getScaffoldSourceIds(node));
  }

  function acceptPendingPlan() {
    if (!pendingPlan) return;

    updateProject((current) => ({
      ...current,
      nodes: [...current.nodes, ...pendingPlan.plannedNodes],
      edges: [...current.edges, ...pendingPlan.plannedEdges],
    }));
    setSelectedNodeId(pendingPlan.plannedNodes[0]?.id ?? selectedNodeId);
    setPendingPlan(null);
    setPendingPlanGenerating(false);
    setPlanStatus('Plan accepted. Planned nodes and edges were added to the project.');
  }

  function rejectPendingPlan() {
    setPendingPlan(null);
    setPendingPlanGenerating(false);
    setPlanStatus('Plan rejected. Project was not changed.');
  }

  function deleteEdge(edgeId: string) {
    updateProject((current) => ({
      ...current,
      edges: current.edges.filter((edge) => edge.id !== edgeId),
    }));
    if (selectedEdgeId === edgeId) setSelectedEdgeId('');
  }

  async function registerProvider(event: React.FormEvent) {
    event.preventDefault();
    setStatus('Saving provider...');

    try {
      const nextConfig = await api.registerProvider({
        id: providerId.trim(),
        name: providerName.trim(),
        baseUrl: baseUrl.trim(),
        apiKey,
        headers: parseHeaders(headersJson),
      });
      setConfig(nextConfig);
      setSelectedProviderId(providerId.trim());
      setStatus('Provider saved. API key is stored only in local app config.');
    } catch (error: unknown) {
      setStatus(error instanceof Error ? error.message : 'Failed to save provider.');
    }
  }

  async function discoverModels() {
    if (!selectedProviderId) return;
    setStatus('Discovering models...');
    setTestResult(null);

    try {
      const response = await api.listProviderModels(selectedProviderId);
      setModels(response.models);
      setSelectedModelId(response.models[0]?.id ?? '');
      setStatus(`Discovered ${response.models.length} model(s).`);
    } catch (error: unknown) {
      setStatus(error instanceof Error ? error.message : 'Failed to discover models.');
    }
  }

  async function testProvider() {
    if (!selectedProviderId) return;
    setStatus('Testing provider...');

    try {
      const result = await api.testProvider(
        selectedProviderId,
        selectedCapabilities.includes('embedding') ? undefined : selectedModelId || undefined,
        selectedCapabilities.includes('embedding') ? selectedModelId || undefined : undefined,
      );
      setTestResult(result);
      setStatus(result.errors.length ? 'Provider test completed with errors.' : 'Provider test passed.');
    } catch (error: unknown) {
      setStatus(error instanceof Error ? error.message : 'Provider test failed.');
    }
  }

  async function registerModel() {
    if (!selectedProviderId || !selectedModelId) return;
    setStatus('Registering model...');

    try {
      const nextConfig = await api.registerModel({
        providerId: selectedProviderId,
        modelId: selectedModelId,
        displayName: selectedModelId,
        capabilityTags: selectedCapabilities,
        contextWindowTokens: contextWindowTokens ? Number(contextWindowTokens) : null,
        embeddingDimensions: embeddingDimensions ? Number(embeddingDimensions) : null,
      });
      setConfig(nextConfig);
      setStatus('Model registered.');
    } catch (error: unknown) {
      setStatus(error instanceof Error ? error.message : 'Failed to register model.');
    }
  }

  function toggleCapability(capability: RegisteredModel['capabilityTags'][number]) {
    setSelectedCapabilities((current) =>
      current.includes(capability)
        ? current.filter((item) => item !== capability)
        : [...current, capability],
    );
  }

  function updateModelRoute(route: keyof ProjectFile['settings']['modelRouting'], modelId: string) {
    updateProject((current) => ({
      ...current,
      settings: {
        ...current.settings,
        modelRouting: {
          ...current.settings.modelRouting,
          [route]: modelId || null,
        },
      },
    }));
  }

  async function addKnowledgeDocument(event: React.FormEvent) {
    event.preventDefault();
    setKnowledgeStatus('Adding knowledge document...');

    try {
      const response = await api.addKnowledgeDocument({
        title: knowledgeTitle.trim() || 'Untitled Document',
        text: knowledgeText,
        tags: knowledgeTags
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
      });
      setKnowledge(response.metadata);
      setKnowledgeTitle('');
      setKnowledgeTags('');
      setKnowledgeText('');
      setKnowledgeStatus(
        response.reindex.unavailableReason
          ? `Document saved. Index unavailable: ${response.reindex.unavailableReason}`
          : `Document saved and indexed ${response.reindex.indexedChunks} chunk(s).`,
      );
    } catch (error: unknown) {
      setKnowledgeStatus(error instanceof Error ? error.message : 'Failed to add knowledge document.');
    }
  }

  async function reindexKnowledge() {
    setKnowledgeStatus('Reindexing knowledge base...');

    try {
      const response = await api.reindexKnowledge();
      const nextKnowledge = await api.getKnowledge();
      setKnowledge(nextKnowledge);
      setKnowledgeStatus(
        response.unavailableReason
          ? `Index unavailable: ${response.unavailableReason}`
          : `Indexed ${response.indexedChunks} chunk(s).`,
      );
    } catch (error: unknown) {
      setKnowledgeStatus(error instanceof Error ? error.message : 'Failed to reindex knowledge base.');
    }
  }

  function startCanvasPan(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('.canvas-node') || target.closest('.edge-popover') || target.closest('.edge-hitline')) return;
    setSelectedEdgeId('');
    setEdgeMenu(null);
    canvasInteractionRef.current = {
      kind: 'pan',
      startClient: { x: event.clientX, y: event.clientY },
      startViewport: canvasViewport,
    };
  }

  function startNodeDrag(event: React.PointerEvent<HTMLElement>, node: CanvasNode, pending: boolean) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedNodeId(pending ? '' : node.id);
    setSelectedEdgeId('');
    setEdgeMenu(null);
    canvasInteractionRef.current = {
      kind: 'node-drag',
      nodeId: node.id,
      pending,
      startClient: { x: event.clientX, y: event.clientY },
      startPosition: node.position,
    };
  }

  function startNodeResize(event: React.PointerEvent<HTMLButtonElement>, node: CanvasNode, pending: boolean) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    delete actionMenuCollapsedHeightRef.current[node.id];
    setSelectedNodeId(pending ? '' : node.id);
    setSelectedEdgeId('');
    setEdgeMenu(null);
    canvasInteractionRef.current = {
      kind: 'node-resize',
      nodeId: node.id,
      pending,
      startClient: { x: event.clientX, y: event.clientY },
      startSize: node.size,
    };
  }

  function startEdgeConnection(event: React.PointerEvent<HTMLElement>, node: CanvasNode, pending: boolean) {
    if (isGenerating || pending) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedNodeId('');
    setSelectedEdgeId('');
    setEdgeMenu(null);
    setConnectingEdge({ sourceNodeId: node.id, current: screenToCanvas(event.clientX, event.clientY) });
  }

  function handleCanvasDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const type = event.dataTransfer.getData('application/x-novel-canvas-node-type') as NodeType;
    if (!nodeTypes.includes(type)) return;
    addNodeAt(type, screenToCanvas(event.clientX, event.clientY));
  }

  function edgePoint(node: CanvasNode, side: 'source' | 'target'): Point {
    return {
      x: node.position.x + (side === 'source' ? node.size.width : 0),
      y: node.position.y + node.size.height / 2,
    };
  }

  function edgeMidpoint(edge: CanvasEdge, nodes: CanvasNode[]): Point | null {
    const source = nodes.find((node) => node.id === edge.sourceNodeId);
    const target = nodes.find((node) => node.id === edge.targetNodeId);
    if (!source || !target) return null;
    const start = edgePoint(source, 'source');
    const end = edgePoint(target, 'target');
    return {
      x: (start.x + end.x) / 2,
      y: (start.y + end.y) / 2,
    };
  }

  function nodeActionLabel(action: NodeAIAction) {
    const labels: Record<NodeAIAction, string> = {
      'complete-outline': 'Complete Outline',
      'complete-scene': 'Complete Scene',
      'generate-scene-paragraph-scaffold': 'Generate Scene Scaffold',
      'generate-paragraph-tasks': 'Generate Paragraph Tasks',
      'generate-paragraph': 'Generate Paragraph',
      'generate-review': 'Generate Review',
    };
    return labels[action];
  }

  function getNodeActions(node: CanvasNode): NodeAIAction[] {
    if (node.type === 'outline') return ['complete-outline', 'generate-scene-paragraph-scaffold'];
    if (node.type === 'scene') return ['complete-scene', 'generate-paragraph-tasks'];
    if (node.type === 'paragraph') return ['generate-paragraph'];
    if (node.type === 'review') return ['generate-review'];
    return [];
  }

  function isNodeActionDisabled(node: CanvasNode, action: NodeAIAction) {
    if (isGenerating) return true;
    if (action === 'complete-outline' || action === 'complete-scene') return !hasIncomingReference(node.id);
    if (action === 'generate-review') {
      return getIncomingNodes(node.id, 'review_target').length < 1;
    }
    return false;
  }

  function nodeActionHint(node: CanvasNode, action: NodeAIAction) {
    if (action === 'complete-outline' || action === 'complete-scene') {
      return hasIncomingReference(node.id) ? '' : 'Needs incoming reference';
    }
    if (action === 'generate-review') {
      return getIncomingNodes(node.id, 'review_target').length ? '' : 'Needs review_target';
    }
    return '';
  }

  function runNodeAction(node: CanvasNode, action: NodeAIAction) {
    if (isNodeActionDisabled(node, action)) {
      const hint = nodeActionHint(node, action);
      if (hint) setGenerationStatus(hint);
      return;
    }

    if (action === 'complete-outline' || action === 'complete-scene') {
      void completeStructureNode(node);
      return;
    }
    if (action === 'generate-scene-paragraph-scaffold') {
      generateScaffoldFromNode(node, 'generate-scenes');
      return;
    }
    if (action === 'generate-paragraph-tasks') {
      generateScaffoldFromNode(node, 'generate-paragraph-tasks');
      return;
    }
    if (action === 'generate-paragraph') {
      setSelectedNodeId(node.id);
      setSelectedEdgeId('');
      void generateParagraphForNode(node);
      return;
    }
    if (action === 'generate-review') {
      setSelectedNodeId(node.id);
      setSelectedEdgeId('');
      void generateReviewForNode(node);
    }
  }

  function renderLeftRail(projectData: ProjectFile) {
    return (
      <aside className="canvas-rail">
        <section className="rail-section">
          <h2>Project</h2>
          <label>
            Title
            <input
              value={projectData.title}
              disabled={isGenerating}
              onChange={(event) => updateProject((current) => ({ ...current, title: event.target.value }))}
            />
          </label>
          <div className="button-row">
            <button type="button" className="secondary-button" onClick={() => void loadStoredProject()} disabled={isGenerating}>
              Read
            </button>
            <button type="button" onClick={() => saveProject()} disabled={isGenerating}>
              Save
            </button>
            <button type="button" className="secondary-button" onClick={exportProjectJson} disabled={isGenerating}>
              Save As
            </button>
            <button type="button" className="secondary-button" onClick={() => void createNewProject()} disabled={isGenerating}>
              New Project
            </button>
          </div>
          <label className={`file-button ${isGenerating ? 'disabled-file-button' : ''}`}>
            Load JSON
            <input
              type="file"
              accept="application/json,.json"
              disabled={isGenerating}
              onChange={(event) => {
                void importProjectJson(event.target.files?.[0] ?? null);
                event.target.value = '';
              }}
            />
          </label>
          <p className="meta">{saveState}</p>
          <p className="meta">{generationStatus}</p>
          <p className="meta">{planStatus}</p>
          {isGenerating ? (
            <button type="button" className="danger-button" onClick={cancelParagraphGeneration}>
              Cancel Generation
            </button>
          ) : null}
          {pendingPlan ? (
            <div className="button-row">
              <button type="button" onClick={acceptPendingPlan} disabled={isGenerating}>
                Accept Plan
              </button>
              <button type="button" className="secondary-button" onClick={rejectPendingPlan} disabled={isGenerating}>
                Reject Plan
              </button>
            </div>
          ) : null}
        </section>

        <section className="rail-section">
          <h2>Nodes</h2>
          <div className="canvas-tools">
            {nodeTypes.map((type) => (
              <button
                key={type}
                type="button"
                className={newNodeType === type ? 'active-tool' : ''}
                draggable={!isGenerating}
                disabled={isGenerating}
                onClick={() => setNewNodeType(type)}
                onDragStart={(event) => {
                  event.dataTransfer.setData('application/x-novel-canvas-node-type', type);
                  event.dataTransfer.effectAllowed = 'copy';
                }}
              >
                {type.replace('_', ' ')}
              </button>
            ))}
          </div>
        </section>

        <section className="rail-section relationship-section">
          <h2>Relationships</h2>
          <p className="meta">Double-click a node to center it on the canvas.</p>
          <div className="relationship-list">
            {projectData.nodes.length ? (
              projectData.nodes.map((node) => {
                const incoming = projectData.edges.filter((edge) => edge.targetNodeId === node.id);
                const outgoing = projectData.edges.filter((edge) => edge.sourceNodeId === node.id);
                return (
                  <button
                    key={node.id}
                    type="button"
                    className={`relationship-node-row ${node.id === selectedNodeId ? 'selected' : ''}`}
                    onClick={() => setSelectedNodeId(node.id)}
                    onDoubleClick={() => centerNodeInCanvas(node)}
                  >
                    <span className="relationship-node-title">{node.title}</span>
                    <span className="relationship-node-meta">{node.type}</span>
                    <span className="relationship-node-counts">
                      <span>{incoming.length} in</span>
                      <span>{outgoing.length} out</span>
                    </span>
                  </button>
                );
              })
            ) : (
              <p className="meta">No nodes yet.</p>
            )}
          </div>
        </section>

        <section className="rail-section semantic-legend">
          <h2>Semantic Colors</h2>
          {edgeSemantics.map((semantic) => (
            <span key={semantic} style={{ '--semantic-color': semanticColors[semantic] } as React.CSSProperties}>
              {semantic}
            </span>
          ))}
        </section>
      </aside>
    );
  }

  function renderContextPreview() {
    if (!selectedNode || !contextPreview) {
      return (
        <section className="panel">
          <h2>Context Preview</h2>
          <p className="meta">Select a paragraph or review node to preview direct context.</p>
        </section>
      );
    }

    if (contextPreview.mode === 'unsupported') {
      return (
        <section className="panel">
          <h2>Context Preview</h2>
          <p className="meta">Context is assembled only for paragraph and review targets.</p>
          {contextPreview.excluded.length ? (
            <div className="context-excluded">
              {contextPreview.excluded.map((item) => (
                <div key={item.edge.id}>{item.reason}</div>
              ))}
            </div>
          ) : null}
        </section>
      );
    }

    const groupedItems = contextPreview.items.reduce<Record<string, ContextPreviewItem[]>>((groups, item) => {
      const label = contextSectionLabels[item.edge.semantic];
      return { ...groups, [label]: [...(groups[label] ?? []), item] };
    }, {});

    return (
      <section className="panel">
        <h2>Context Preview</h2>
        <div className="context-summary">
          <span>{contextPreview.mode === 'paragraph' ? 'Paragraph generation' : 'Review generation'}</span>
          <span>
            {contextPreview.estimatedTokens} / {contextPreview.compressionThreshold} est. tokens
          </span>
        </div>
        {contextPreview.compressionNeeded ? (
          <div className="warning-box">Context exceeds the MVP compression threshold.</div>
        ) : null}
        {Object.keys(groupedItems).length ? (
          Object.entries(groupedItems).map(([section, items]) => (
            <div key={section} className="context-group">
              <h3>{section}</h3>
              {items.map((item) => (
                <article key={item.edge.id} className="context-item">
                  <div className="context-item-header">
                    <strong>{item.node.title}</strong>
                    <span>{item.node.type}</span>
                  </div>
                  <p>{item.node.body?.trim() || 'Empty body'}</p>
                  <small>
                    {item.edge.semantic} - {item.estimatedTokens} est. tokens
                  </small>
                </article>
              ))}
            </div>
          ))
        ) : (
          <p className="meta">No valid direct incoming context nodes.</p>
        )}
        {contextPreview.ragAuthorizers.length ? (
          <div className="context-group">
            <h3>RAG SUPPLEMENTAL CONTEXT</h3>
            <p className="meta">
              {contextPreview.ragAuthorizers.length} linked supplemental-info reference node(s) authorize RAG retrieval.
            </p>
            {ragStatus ? <p className="meta">{ragStatus}</p> : null}
            {ragPreview?.snippets.map((snippet) => (
              <article key={snippet.chunkId} className="context-item">
                <div className="context-item-header">
                  <strong>{snippet.documentTitle}</strong>
                  <span>{snippet.score.toFixed(3)}</span>
                </div>
                <p>{snippet.text}</p>
                <small>{snippet.chunkId}</small>
              </article>
            ))}
          </div>
        ) : null}
        {contextPreview.excluded.length ? (
          <div className="context-excluded">
            <strong>Excluded direct links</strong>
            {contextPreview.excluded.map((item) => (
              <div key={item.edge.id}>
                {(item.node?.title ?? item.edge.sourceNodeId)} - {item.edge.semantic}: {item.reason}
              </div>
            ))}
          </div>
        ) : null}
      </section>
    );
  }

  function renderCanvas() {
    if (!project) return renderProjectLauncher();

    return (
      <section className="canvas-page">
        {renderLeftRail(project)}
        <section className="canvas-panel">
          <div
            ref={canvasStageRef}
            className="canvas-stage"
            onPointerDown={startCanvasPan}
            onWheel={handleViewportWheel}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'copy';
            }}
            onDrop={handleCanvasDrop}
          >
            <div className="canvas-zoom-controls canvas-zoom-hud">
              <button
                type="button"
                className="secondary-button"
                onClick={() =>
                  setCanvasViewport((current) => ({ ...current, scale: clamp(current.scale / 1.12, 0.3, 2.2) }))
                }
              >
                -
              </button>
              <span>{Math.round(canvasViewport.scale * 100)}%</span>
              <button
                type="button"
                className="secondary-button"
                onClick={() =>
                  setCanvasViewport((current) => ({ ...current, scale: clamp(current.scale * 1.12, 0.3, 2.2) }))
                }
              >
                +
              </button>
            </div>
            <div
              className="canvas-viewport"
              style={{
                transform: `translate(${canvasViewport.x}px, ${canvasViewport.y}px) scale(${canvasViewport.scale})`,
              }}
            >
              <svg className="edge-layer" width="4000" height="3000" aria-hidden="true">
                <defs>
                  <marker id="arrow" markerHeight="8" markerWidth="8" orient="auto" refX="7" refY="4">
                    <path d="M0,0 L8,4 L0,8 Z" fill="#99a3b3" />
                  </marker>
                </defs>
                {canvasEdges.map((edge) => {
                  const source = canvasNodes.find((node) => node.id === edge.sourceNodeId);
                  const target = canvasNodes.find((node) => node.id === edge.targetNodeId);
                  if (!source || !target) return null;
                  const isPending = pendingPlan?.plannedEdges.some((plannedEdge) => plannedEdge.id === edge.id);
                  const start = edgePoint(source, 'source');
                  const end = edgePoint(target, 'target');
                  const isHighlighted = incomingHighlightEdgeIds.has(edge.id);
                  const semanticColor = semanticColors[edge.semantic];

                  return (
                    <g key={edge.id} style={{ '--semantic-color': semanticColor } as React.CSSProperties}>
                      <line
                        className="edge-hitline"
                        x1={start.x}
                        y1={start.y}
                        x2={end.x}
                        y2={end.y}
                        onClick={(event) => {
                          if (isPending) return;
                          event.stopPropagation();
                          setSelectedEdgeId(edge.id);
                          setSelectedNodeId('');
                          setEdgeMenu(null);
                        }}
                        onContextMenu={(event) => {
                          if (isPending) return;
                          event.preventDefault();
                          event.stopPropagation();
                          const rect = canvasStageRef.current?.getBoundingClientRect();
                          setSelectedEdgeId(edge.id);
                          setSelectedNodeId('');
                          setEdgeMenu({
                            edgeId: edge.id,
                            x: rect ? event.clientX - rect.left : event.clientX,
                            y: rect ? event.clientY - rect.top : event.clientY,
                          });
                        }}
                      />
                      <line
                        className={`${isPending ? 'pending-edge' : ''} ${selectedEdgeId === edge.id ? 'selected-edge' : ''} ${isHighlighted ? 'highlighted-edge' : ''}`}
                        x1={start.x}
                        y1={start.y}
                        x2={end.x}
                        y2={end.y}
                        markerEnd="url(#arrow)"
                      />
                    </g>
                  );
                })}
                {connectingEdge ? (() => {
                  const source = canvasNodes.find((node) => node.id === connectingEdge.sourceNodeId);
                  if (!source) return null;
                  const start = edgePoint(source, 'source');
                  return (
                    <line
                      className="draft-edge"
                      x1={start.x}
                      y1={start.y}
                      x2={connectingEdge.current.x}
                      y2={connectingEdge.current.y}
                      markerEnd="url(#arrow)"
                    />
                  );
                })() : null}
              </svg>
              {canvasNodes.map((node) => {
                const isPending = Boolean(pendingPlan?.plannedNodes.some((plannedNode) => plannedNode.id === node.id));
                const isPendingGenerating = isPending && pendingPlanGenerating;
                const isGenerationTarget = generationTargetNodeId === node.id;
                const pendingCompletion = pendingNodeCompletions[node.id];
                const hasPendingCompletion = pendingCompletion !== undefined;
                const isWaitingForPendingText = isGenerationTarget && hasPendingCompletion && pendingCompletion.length === 0;
                const bodyLocked = isGenerating || isPending || hasPendingCompletion;
                const bodyValue = hasPendingCompletion ? pendingCompletion : (node.body ?? '');
                const bodyPlaceholder = hasPendingCompletion
                  ? 'Waiting for generated text...'
                  : isPending
                    ? 'Pending node body is locked until accepted.'
                    : 'Write node content here.';
                const highlightSemantic = incomingHighlightByNodeId.get(node.id);
                const nodeActions = isPending ? [] : getNodeActions(node);
                return (
                  <article
                    key={node.id}
                    data-node-id={node.id}
                    className={`canvas-node ${node.id === selectedNodeId ? 'selected' : ''} ${isPending ? 'pending-node' : ''} ${isPendingGenerating || isWaitingForPendingText ? 'plan-generating-node' : ''} ${isGenerationTarget ? 'generating-node' : ''} ${hasPendingCompletion ? 'pending-completion-node' : ''} ${highlightSemantic ? 'context-source-node' : ''}`}
                    style={{
                      '--semantic-color': highlightSemantic ? semanticColors[highlightSemantic] : undefined,
                      left: node.position.x,
                      top: node.position.y,
                      width: node.size.width,
                      height: node.size.height,
                    } as React.CSSProperties}
                    onPointerDownCapture={(event) => {
                      if (event.button === 2) startEdgeConnection(event, node, isPending);
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    onContextMenu={(event) => {
                      if (!isPending) event.preventDefault();
                    }}
                    onClick={() => {
                      if (!isPending) {
                        setSelectedNodeId(node.id);
                        setSelectedEdgeId('');
                        setEdgeMenu(null);
                      }
                    }}
                  >
                    <button
                      type="button"
                      className="node-drag-handle"
                      onPointerDown={(event) => startNodeDrag(event, node, isPending)}
                    >
                      <span className="node-type">{isPending ? `pending ${node.type}` : node.type}</span>
                      <span className="node-handle-title">{node.title}</span>
                    </button>
                    <input
                      className="node-title-input"
                      value={node.title}
                      disabled={isGenerating || isPending}
                      onPointerDown={(event) => event.stopPropagation()}
                      onChange={(event) => updateNodeFromCanvas(node.id, { title: event.target.value })}
                    />
                    <textarea
                      className="node-body-input"
                      value={bodyValue}
                      disabled={bodyLocked}
                      placeholder={bodyPlaceholder}
                      onPointerDown={(event) => event.stopPropagation()}
                      onChange={(event) => updateNodeFromCanvas(node.id, { body: event.target.value })}
                    />
                    {hasPendingCompletion ? (
                      <div className="pending-completion-actions" onPointerDown={(event) => event.stopPropagation()}>
                        <span className="pending-completion-label">
                          {isGenerationTarget ? 'Generating pending text...' : 'Pending generated text'}
                        </span>
                        <button type="button" onClick={() => acceptNodeCompletion(node)} disabled={isGenerating}>
                          Accept
                        </button>
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => rejectNodeCompletion(node.id)}
                          disabled={isGenerating}
                        >
                          Reject
                        </button>
                      </div>
                    ) : null}
                    <input
                      className="node-tag-input"
                      value={node.metadata.tags.join(', ')}
                      disabled={isGenerating || isPending}
                      placeholder="tags"
                      onPointerDown={(event) => event.stopPropagation()}
                      onChange={(event) =>
                        updateNodeFromCanvas(node.id, {
                          metadata: {
                            ...node.metadata,
                            tags: event.target.value
                              .split(',')
                              .map((tag) => tag.trim())
                              .filter(Boolean),
                          },
                        })
                      }
                    />
                    {!isPending ? (
                      <details
                        className="node-action-menu"
                        onPointerDown={(event) => event.stopPropagation()}
                        onToggle={(event) => handleActionMenuToggle(event, node)}
                      >
                        <summary>Actions</summary>
                        <div>
                          {node.type === 'paragraph' ? (
                            <label className="compact-label">
                              Mode
                              <select
                                value={generationMode}
                                disabled={isGenerating}
                                onChange={(event) => setGenerationMode(event.target.value as 'replace' | 'append')}
                              >
                                <option value="replace">replace</option>
                                <option value="append">append</option>
                              </select>
                            </label>
                          ) : null}
                          {nodeActions.map((action) => {
                            const hint = nodeActionHint(node, action);
                            return (
                              <button
                                key={action}
                                type="button"
                                className="secondary-button"
                                disabled={isNodeActionDisabled(node, action)}
                                title={hint}
                                onClick={() => runNodeAction(node, action)}
                              >
                                {nodeActionLabel(action)}
                              </button>
                            );
                          })}
                          <button
                            type="button"
                            className="danger-button"
                            disabled={isGenerating}
                            onClick={() => {
                              setSelectedNodeId(node.id);
                              setSelectedEdgeId('');
                              deleteSelectedNodeById(node.id);
                            }}
                          >
                            Delete Node
                          </button>
                        </div>
                      </details>
                    ) : null}
                    <button
                      type="button"
                      className="node-resize-handle"
                      aria-label={`Resize ${node.title}`}
                      onPointerDown={(event) => startNodeResize(event, node, isPending)}
                    />
                    {isPendingGenerating || isWaitingForPendingText ? (
                      <div className="node-generating-overlay">
                        {isWaitingForPendingText ? 'pending...' : 'generating'}
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
            {edgeMenu && selectedEdge && edgeMenu.edgeId === selectedEdge.id ? (
              <div
                className="edge-popover"
                style={{
                  left: edgeMenu.x,
                  top: edgeMenu.y,
                }}
                onPointerDown={(event) => event.stopPropagation()}
                onContextMenu={(event) => event.preventDefault()}
              >
                <label>
                  Edge semantic
                  <select
                    value={selectedEdge.semantic}
                    disabled={isGenerating}
                    onChange={(event) => updateEdgeSemantic(selectedEdge.id, event.target.value as EdgeSemantic)}
                  >
                    {edgeSemantics.map((semantic) => (
                      <option key={semantic} value={semantic}>
                        {semantic}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="danger-button"
                  onClick={() => {
                    deleteEdge(selectedEdge.id);
                    setEdgeMenu(null);
                  }}
                  disabled={isGenerating}
                >
                  Delete Edge
                </button>
              </div>
            ) : null}
          </div>
        </section>

      </section>
    );
  }

  function renderProjectLauncher() {
    return (
      <section className="project-launcher">
        <section className="panel launcher-panel">
          <p className="eyebrow">Novel Canvas Project</p>
          <h2>Choose a project to begin</h2>
          <p className="meta">
            Read the currently saved project, load a project JSON file, or create a blank project before entering the canvas.
          </p>
          <div className="launcher-actions">
            <button type="button" onClick={() => void loadStoredProject(false)}>
              Read Current Project
            </button>
            <label className="file-button">
              Load Project JSON
              <input
                type="file"
                accept="application/json,.json"
                onChange={(event) => {
                  void importProjectJson(event.target.files?.[0] ?? null);
                  event.target.value = '';
                }}
              />
            </label>
            <button type="button" className="secondary-button" onClick={() => void createNewProject()}>
              New Project
            </button>
          </div>
          <p className="meta">{saveState}</p>
        </section>
      </section>
    );
  }

  function renderSettings() {
    return (
      <section className="layout-grid">
        <form className="panel" onSubmit={registerProvider}>
          <h2>Provider</h2>
          <label>
            Provider ID
            <input value={providerId} onChange={(event) => setProviderId(event.target.value)} required />
          </label>
          <label>
            Provider Name
            <input value={providerName} onChange={(event) => setProviderName(event.target.value)} required />
          </label>
          <label>
            API Root URL
            <input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://api.siliconflow.cn/v1"
              required
            />
            <span className="field-hint">Example: https://api.siliconflow.cn/v1</span>
          </label>
          <label>
            API Key
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="Stored locally only"
            />
          </label>
          <label>
            Custom Headers JSON
            <textarea
              value={headersJson}
              onChange={(event) => setHeadersJson(event.target.value)}
              placeholder='{"X-Header":"value"}'
              rows={4}
            />
          </label>
          <button type="submit">Save Provider</button>
        </form>

        <section className="panel">
          <h2>Models</h2>
          <label>
            Provider
            <select value={selectedProviderId} onChange={(event) => setSelectedProviderId(event.target.value)}>
              <option value="">Select provider</option>
              {config.providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
          </label>
          {selectedProvider ? (
            <p className="meta">
              {selectedProvider.baseUrl} - API key {selectedProvider.hasApiKey ? 'saved' : 'missing'}
            </p>
          ) : null}
          <div className="button-row">
            <button type="button" onClick={discoverModels} disabled={!selectedProviderId}>
              Discover Models
            </button>
            <button type="button" onClick={testProvider} disabled={!selectedProviderId}>
              Test Selected
            </button>
          </div>
          <label>
            Discovered Model
            <select value={selectedModelId} onChange={(event) => setSelectedModelId(event.target.value)}>
              <option value="">Select model</option>
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.id}
                </option>
              ))}
            </select>
          </label>
          <div className="capability-grid">
            {capabilityOptions.map((capability) => (
              <label key={capability} className="checkbox-label">
                <input
                  type="checkbox"
                  checked={selectedCapabilities.includes(capability)}
                  onChange={() => toggleCapability(capability)}
                />
                {capability}
              </label>
            ))}
          </div>
          <p className="field-hint">Capabilities are inferred from the selected model name and can be adjusted manually.</p>
          <label>
            Context Window Tokens
            <input
              type="number"
              value={contextWindowTokens}
              onChange={(event) => setContextWindowTokens(event.target.value)}
              min="0"
            />
          </label>
          <label>
            Embedding Dimensions
            <input
              type="number"
              value={embeddingDimensions}
              onChange={(event) => setEmbeddingDimensions(event.target.value)}
              min="0"
            />
          </label>
          <button type="button" onClick={registerModel} disabled={!selectedProviderId || !selectedModelId}>
            Register Model
          </button>
          {testResult ? (
            <div className="result-box">
              <div>Model listing: {testResult.modelListingOk ? 'ok' : 'failed'}</div>
              <div>Chat: {String(testResult.chatCompletionOk ?? 'not tested')}</div>
              <div>Embedding: {String(testResult.embeddingOk ?? 'not tested')}</div>
              {testResult.errors.map((error) => (
                <div key={error} className="error-text">
                  {error}
                </div>
              ))}
            </div>
          ) : null}
        </section>

        <section className="panel wide">
          <h2>Registered Models</h2>
          <div className="model-table">
            {config.registeredModels.length ? (
              config.registeredModels.map((model) => (
                <div key={model.id} className="model-row">
                  <div>
                    <strong>{model.displayName}</strong>
                    <span>{model.modelId}</span>
                  </div>
                  <div>{model.capabilityTags.join(', ') || 'no capabilities'}</div>
                </div>
              ))
            ) : (
              <p className="meta">No models registered yet.</p>
            )}
          </div>
        </section>

        <section className="panel wide">
          <h2>Model Routing</h2>
          {project ? (
            <div className="routing-grid">
              <label>
                Structure Derivation
                <select
                  value={project.settings.modelRouting.structureDerivationModelId ?? ''}
                  onChange={(event) => updateModelRoute('structureDerivationModelId', event.target.value)}
                >
                  <option value="">Select model</option>
                  {config.registeredModels.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Paragraph Generation
                <select
                  value={project.settings.modelRouting.paragraphGenerationModelId ?? ''}
                  onChange={(event) => updateModelRoute('paragraphGenerationModelId', event.target.value)}
                >
                  <option value="">Select model</option>
                  {config.registeredModels.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Review
                <select
                  value={project.settings.modelRouting.reviewModelId ?? ''}
                  onChange={(event) => updateModelRoute('reviewModelId', event.target.value)}
                >
                  <option value="">Select model</option>
                  {config.registeredModels.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Context Compression
                <select
                  value={project.settings.modelRouting.contextCompressionModelId ?? ''}
                  onChange={(event) => updateModelRoute('contextCompressionModelId', event.target.value)}
                >
                  <option value="">Select model</option>
                  {config.registeredModels.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Embedding
                <select
                  value={project.settings.modelRouting.embeddingModelId ?? ''}
                  onChange={(event) => updateModelRoute('embeddingModelId', event.target.value)}
                >
                  <option value="">Select embedding model</option>
                  {config.registeredModels
                    .filter((model) => model.capabilityTags.includes('embedding'))
                    .map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.displayName}
                      </option>
                    ))}
                </select>
              </label>
            </div>
          ) : (
            <p className="meta">Project is still loading.</p>
          )}
        </section>
      </section>
    );
  }

  function renderKnowledge() {
    return (
      <section className="layout-grid">
        <form className="panel" onSubmit={addKnowledgeDocument}>
          <h2>Add Knowledge Document</h2>
          <label>
            Title
            <input value={knowledgeTitle} onChange={(event) => setKnowledgeTitle(event.target.value)} required />
          </label>
          <label>
            Tags
            <input
              value={knowledgeTags}
              onChange={(event) => setKnowledgeTags(event.target.value)}
              placeholder="worldbuilding, rules"
            />
          </label>
          <label>
            Text
            <textarea
              value={knowledgeText}
              onChange={(event) => setKnowledgeText(event.target.value)}
              rows={16}
              required
            />
          </label>
          <button type="submit">Add and Index</button>
        </form>

        <section className="panel">
          <h2>Knowledge Base</h2>
          <p className="meta">{knowledgeStatus}</p>
          <button type="button" onClick={reindexKnowledge}>
            Reindex
          </button>
          {knowledge ? (
            <div className="knowledge-list">
              <div className="knowledge-summary">
                <span>{knowledge.documents.length} document(s)</span>
                <span>{knowledge.embeddingModelId ? `Embedding: ${knowledge.embeddingModelId}` : 'No embedding index'}</span>
              </div>
              {knowledge.documents.map((document) => (
                <article key={document.id} className="knowledge-row">
                  <strong>{document.title}</strong>
                  <span>{document.chunkIds.length} chunk(s)</span>
                  <small>{document.tags.join(', ') || 'no tags'}</small>
                </article>
              ))}
            </div>
          ) : (
            <p className="meta">Loading knowledge base.</p>
          )}
        </section>
      </section>
    );
  }

  function renderWorldbook() {
    if (!project) return <section className="panel">Loading project...</section>;
    const entries = project.worldbook?.entries ?? [];

    return (
      <section className="layout-grid">
        <section className="panel wide">
          <h2>Worldbook / Lorebook</h2>
          <p className="meta">
            Entries are stored in project.json. Keys trigger entries from the selected target node and its direct incoming source nodes only.
          </p>
          <p className="meta">
            Tags are project-owned labels for grouping and future filtering only, such as character, location, magic-system, canon, draft, spoiler, faction, rule, or timeline.
          </p>
          <div className="button-row">
            <button type="button" onClick={addWorldbookEntry}>
              Add Entry
            </button>
            <button type="button" className="secondary-button" onClick={exportWorldbookJson}>
              Export Worldbook JSON
            </button>
            <label className="secondary-button file-button">
              Import Worldbook JSON
              <input
                type="file"
                accept="application/json,.json"
                onChange={(event) => {
                  void importWorldbookJson(event.target.files?.[0] ?? null);
                  event.target.value = '';
                }}
              />
            </label>
          </div>
          <p className="meta">{worldbookStatus}</p>
        </section>

        {entries.length ? (
          <section className="worldbook-list wide">
            {entries.map((entry) => {
              const isExpanded = expandedWorldbookEntryIds.includes(entry.id);
              return (
                <article key={entry.id} className={`panel worldbook-entry ${isExpanded ? 'expanded' : ''}`}>
                  <button
                    type="button"
                    className="worldbook-entry-summary"
                    aria-expanded={isExpanded}
                    onClick={() => toggleWorldbookEntry(entry.id)}
                  >
                    <span className="worldbook-entry-chevron">{isExpanded ? 'v' : '>'}</span>
                    <span className="worldbook-entry-title">{entry.title || 'Untitled Entry'}</span>
                    <span className={`worldbook-status-badge ${entry.enabled ? 'enabled' : 'disabled'}`}>
                      {entry.enabled ? 'enabled' : 'disabled'}
                    </span>
                    {entry.alwaysOn ? <span className="worldbook-status-badge">always-on</span> : null}
                    <span className="worldbook-entry-meta">
                      {entry.keys.length} key{entry.keys.length === 1 ? '' : 's'}
                      {entry.tags.length ? ` - ${entry.tags.join(', ')}` : ''}
                    </span>
                  </button>

                  {isExpanded ? (
                    <div className="worldbook-entry-body">
                      <div className="worldbook-entry-header">
                        <label className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={entry.enabled}
                            onChange={(event) => updateWorldbookEntry(entry.id, { enabled: event.target.checked })}
                          />
                          enabled
                        </label>
                        <label className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={entry.alwaysOn}
                            onChange={(event) => updateWorldbookEntry(entry.id, { alwaysOn: event.target.checked })}
                          />
                          always-on
                        </label>
                        <button type="button" className="danger-button" onClick={() => deleteWorldbookEntry(entry.id)}>
                          Delete
                        </button>
                      </div>
                      <label>
                        Title
                        <input
                          value={entry.title}
                          onChange={(event) => updateWorldbookEntry(entry.id, { title: event.target.value })}
                        />
                      </label>
                      <label>
                        Keys
                        <input
                          value={entry.keys.join(', ')}
                          placeholder="Alicia, Silver Capital, 被遗忘的国度，国度天宇"
                          onChange={(event) =>
                            updateWorldbookEntry(entry.id, {
                              keys: parseDelimitedList(event.target.value),
                            })
                          }
                        />
                        <span className="field-hint">
                          Use comma, Chinese comma, enumeration comma, semicolon, or new lines. Matching is case-insensitive substring matching.
                        </span>
                      </label>
                      <label>
                        Tags
                        <input
                          value={entry.tags.join(', ')}
                          placeholder="character, canon, faction"
                          onChange={(event) =>
                            updateWorldbookEntry(entry.id, {
                              tags: parseDelimitedList(event.target.value),
                            })
                          }
                        />
                        <span className="field-hint">Project tags are exported with this project, but they do not trigger entries.</span>
                      </label>
                      <div className="routing-grid">
                        <label>
                          Priority
                          <input
                            type="number"
                            value={entry.priority}
                            onChange={(event) => updateWorldbookEntry(entry.id, { priority: Number(event.target.value) })}
                          />
                        </label>
                        <label>
                          Token Budget
                          <input
                            type="number"
                            min="0"
                            value={entry.tokenBudget ?? ''}
                            placeholder="optional"
                            onChange={(event) =>
                              updateWorldbookEntry(entry.id, {
                                tokenBudget: event.target.value ? Number(event.target.value) : null,
                              })
                            }
                          />
                        </label>
                      </div>
                      <label>
                        Insertion Position
                        <select
                          value={entry.insertionPosition}
                          onChange={(event) =>
                            updateWorldbookEntry(entry.id, {
                              insertionPosition: event.target.value as WorldbookEntry['insertionPosition'],
                            })
                          }
                        >
                          <option value="before_context">before_context</option>
                          <option value="after_context">after_context</option>
                        </select>
                      </label>
                      <label>
                        Content
                        <textarea
                          value={entry.content}
                          rows={10}
                          onChange={(event) => updateWorldbookEntry(entry.id, { content: event.target.value })}
                        />
                      </label>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </section>
        ) : (
          <section className="panel wide">
            <p className="meta">No worldbook entries yet.</p>
          </section>
        )}
      </section>
    );
  }

  function renderExport() {
    if (!project) {
      return <section className="panel">Loading project...</section>;
    }

    return (
      <section className="layout-grid">
        <section className="panel">
          <h2>TXT Export</h2>
          <p className="meta">{exportStatus}</p>
          <label>
            Mode
            <select value={exportMode} onChange={(event) => setExportMode(event.target.value as 'assets' | 'manuscript')}>
              <option value="assets">assets</option>
              <option value="manuscript">manuscript</option>
            </select>
          </label>
          <div className="button-row">
            <button type="button" className="secondary-button" onClick={selectAllExportNodes}>
              Select All
            </button>
            <button type="button" className="secondary-button" onClick={() => setExportNodeIds([])}>
              Clear
            </button>
          </div>
          <div className="source-node-list export-node-list">
            {project.nodes.length ? (
              project.nodes.map((node) => (
                <label key={node.id} className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={exportNodeIds.includes(node.id)}
                    onChange={() => toggleExportNode(node.id)}
                  />
                  <span>
                    {node.title}
                    <small>
                      {node.type} - {node.metadata.tags.join(', ') || 'no tags'}
                    </small>
                  </span>
                </label>
              ))
            ) : (
              <p className="meta">No nodes to export.</p>
            )}
          </div>
          <button type="button" onClick={exportTxt}>
            Export TXT
          </button>
          <p className="meta">
            If no nodes are selected, all nodes are exported. Manuscript mode only includes selected paragraph nodes and container contents.
          </p>
        </section>

        <section className="panel">
          <h2>Project JSON</h2>
          <p className="meta">Save As and Load use the same ProjectFile JSON format and exclude local app config secrets.</p>
          <button type="button" onClick={exportProjectJson}>
            Save As Project JSON
          </button>
          <label className="file-button">
            Load Project JSON
            <input
              type="file"
              accept="application/json,.json"
              onChange={(event) => {
                void importProjectJson(event.target.files?.[0] ?? null);
                event.target.value = '';
              }}
            />
          </label>
        </section>
      </section>
    );
  }

  return (
    <main className="app-shell">
      <header className="top-bar">
        <div>
          <h1>Novel Canvas</h1>
          <p>
            {activeView === 'canvas'
              ? 'Canvas CRUD, autosave, and semantic highlighting'
              : activeView === 'worldbook'
                ? 'Project worldbook and triggered lore entries'
                : activeView === 'knowledge'
                  ? 'Local knowledge base and RAG index'
                  : activeView === 'export'
                    ? 'TXT export and project JSON import/export'
                    : 'AI Settings and provider tests'}
          </p>
        </div>
        <div className="top-actions">
          <div className="segmented-control">
            <button
              type="button"
              className={activeView === 'canvas' ? 'active' : ''}
              onClick={() => setActiveView('canvas')}
            >
              Canvas
            </button>
            <button
              type="button"
              className={activeView === 'knowledge' ? 'active' : ''}
              onClick={() => setActiveView('knowledge')}
            >
              Knowledge
            </button>
            <button
              type="button"
              className={activeView === 'worldbook' ? 'active' : ''}
              onClick={() => setActiveView('worldbook')}
            >
              Worldbook
            </button>
            <button
              type="button"
              className={activeView === 'export' ? 'active' : ''}
              onClick={() => setActiveView('export')}
            >
              Export
            </button>
            <button
              type="button"
              className={activeView === 'settings' ? 'active' : ''}
              onClick={() => setActiveView('settings')}
            >
              Settings
            </button>
          </div>
          <div className="status-pill">
            {activeView === 'canvas'
              ? saveState
              : activeView === 'worldbook'
                ? worldbookStatus
                : activeView === 'knowledge'
                  ? knowledgeStatus
                  : activeView === 'export'
                    ? exportStatus
                    : status}
          </div>
        </div>
      </header>

      {activeView === 'canvas'
        ? renderCanvas()
        : activeView === 'worldbook'
          ? renderWorldbook()
          : activeView === 'knowledge'
            ? renderKnowledge()
            : activeView === 'export'
              ? renderExport()
              : renderSettings()}
    </main>
  );
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
