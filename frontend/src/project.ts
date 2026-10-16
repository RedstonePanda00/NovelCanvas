import type {
  CanvasEdge,
  CanvasNode,
  EdgeSemantic,
  NodeMetadata,
  NodeWorkbench,
  NodeType,
  Point,
  ProjectFile,
  StructureWorkflow,
  WorldbookEntry,
} from './types';

export const nodeTypes: NodeType[] = [
  'paragraph', 'outline', 'scene', 'character', 'supplemental_info', 'instruction', 'container',
];

export const edgeSemantics: EdgeSemantic[] = [
  'must_follow', 'instruction', 'reference', 'can_rewrite', 'style_reference', 'review_basis', 'review_target',
];
export const newEdgeSemantics = edgeSemantics.filter((semantic) => !semantic.startsWith('review_'));

export const semanticColors: Record<EdgeSemantic, string> = {
  must_follow: '#f97316', instruction: '#fbbf24', reference: '#60a5fa', can_rewrite: '#a78bfa',
  style_reference: '#ec4899', review_basis: '#22d3ee', review_target: '#34d399',
};

export const nowIso = () => new Date().toISOString();

export function createMetadata(tags: string[] = []): NodeMetadata {
  const timestamp = nowIso();
  return { createdAt: timestamp, updatedAt: timestamp, sourceNodeIds: [], generatedByWorkflow: null, generatedPlanId: null, tags };
}

export function createNode(type: NodeType, index: number, position: Point): CanvasNode {
  const size = type === 'container' ? { width: 420, height: 260 } : { width: 340, height: 250 };
  return {
    id: `node-${crypto.randomUUID()}`,
    type,
    title: `${type.replace('_', ' ')} ${index + 1}`,
    body: '',
    position,
    size,
    metadata: createMetadata(),
    outlineLevel: null,
    targetWordCount: null,
    narrativeTask: null,
    childNodeIds: [],
  };
}

export function createEdge(sourceNodeId: string, targetNodeId: string, semantic: EdgeSemantic = 'reference'): CanvasEdge {
  const timestamp = nowIso();
  return {
    id: `edge-${crypto.randomUUID()}`,
    sourceNodeId,
    targetNodeId,
    semantic,
    label: semantic,
    metadata: { createdAt: timestamp, updatedAt: timestamp, sourceNodeIds: [], tags: [] },
  };
}

export function createWorldbookEntry(): WorldbookEntry {
  return {
    id: `worldbook-${crypto.randomUUID()}`,
    title: 'New Worldbook Entry', content: '', keys: [], tags: [], enabled: true, alwaysOn: false,
    priority: 0, tokenBudget: null, insertionPosition: 'after_context',
  };
}

export function createEmptyProject(title = 'Untitled Novel Canvas Project'): ProjectFile {
  const timestamp = nowIso();
  return {
    version: '0.1.0', title, nodes: [], edges: [], worldbook: { entries: [] }, createdAt: timestamp, updatedAt: timestamp,
    settings: {
      defaultLanguage: 'zh-CN', defaultExportMode: 'manuscript', modelRouting: {}, modelGlobalPrompts: {},
    },
  };
}

export function normalizeProject(project: ProjectFile): ProjectFile {
  const routing = { ...project.settings?.modelRouting };
  delete (routing as Record<string, unknown>).reviewModelId;
  return {
    ...project,
    nodes: (project.nodes ?? []).map((node) => migrateReviewNode({ ...node, childNodeIds: node.childNodeIds ?? [], metadata: { ...node.metadata, tags: node.metadata?.tags ?? [], sourceNodeIds: node.metadata?.sourceNodeIds ?? [] } })),
    workbench: project.workbench ? Object.fromEntries(Object.entries(project.workbench).map(([id, work]) => [id, normalizeWorkbench(work, id)])) : undefined,
    edges: project.edges ?? [],
    worldbook: project.worldbook ?? { entries: [] },
    settings: {
      defaultLanguage: project.settings?.defaultLanguage ?? 'en',
      defaultExportMode: project.settings?.defaultExportMode ?? 'assets',
      modelRouting: routing,
      modelGlobalPrompts: project.settings?.modelGlobalPrompts ?? {},
    },
  };
}

function migrateReviewNode(node: CanvasNode): CanvasNode {
  if ((node.type as string) !== 'review') return node;
  return { ...node, type: 'supplemental_info', metadata: { ...node.metadata, tags: [...new Set([...(node.metadata?.tags ?? []), 'legacy-review'])] } };
}

function normalizeWorkbench(work: NodeWorkbench, id: string): NodeWorkbench {
  let messages = work.messages ?? [];
  let mutations = work.mutations ?? [];
  let versions = (work.versions ?? []).map((version) => ({ ...version, nodeType: ((version.nodeType as string) === 'review' ? 'supplemental_info' : version.nodeType) as NodeType, appliedNodeSnapshot: migrateReviewSnapshot(version.appliedNodeSnapshot) }));
  if (id === '__chat__' || id.startsWith('__chat__:')) {
    const lastReport = messages.reduce((last, message, index) => message.blocks?.length ? index : last, -1);
    messages = messages.map((message, index) => index !== lastReport && message.blocks?.length ? { ...message, blocks: [] } : message);
    const latest = [versions[versions.length - 1]?.createdAt, mutations[mutations.length - 1]?.createdAt].filter((value): value is string => Boolean(value)).sort().pop();
    versions = versions.filter((version) => version.createdAt === latest);
    mutations = mutations.filter((change) => change.createdAt === latest);
  }
  return { ...work, messages, versions, mutations, activeVersionId: versions.some((version) => version.id === work.activeVersionId) ? work.activeVersionId : versions[versions.length - 1]?.id ?? null };
}

function migrateReviewSnapshot(snapshot: string | null | undefined): string | null | undefined {
  if (!snapshot) return snapshot;
  try { return JSON.stringify(migrateReviewNode(JSON.parse(snapshot) as CanvasNode)); } catch { return snapshot; }
}

export function parseDelimitedList(value: string): string[] {
  return Array.from(new Set(value.split(/[,，、；;\r\n]+/).map((item) => item.trim()).filter(Boolean)));
}

export function defaultSemantic(source: CanvasNode | undefined, _target: CanvasNode): EdgeSemantic {
  if (source?.type === 'instruction') return 'instruction';
  return 'reference';
}

export function validWorkflow(node: CanvasNode, workflow: StructureWorkflow): boolean {
  if (workflow === 'generate-outline') return node.type !== 'paragraph';
  if (workflow === 'generate-scenes') return node.type === 'outline';
  if (workflow === 'generate-next-scene' || workflow === 'split-scene' || workflow === 'generate-paragraph-tasks') return node.type === 'scene';
  return false;
}

export function downloadText(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export interface Viewport { x: number; y: number; scale: number }

export function fitViewport(nodes: CanvasNode[], width: number, height: number, padding = 80): Viewport {
  if (!nodes.length || width <= 0 || height <= 0) return { x: 24, y: 24, scale: 1 };
  const minX = Math.min(...nodes.map((node) => node.position.x));
  const minY = Math.min(...nodes.map((node) => node.position.y));
  const maxX = Math.max(...nodes.map((node) => node.position.x + node.size.width));
  const maxY = Math.max(...nodes.map((node) => node.position.y + node.size.height));
  const contentWidth = Math.max(1, maxX - minX);
  const contentHeight = Math.max(1, maxY - minY);
  const scale = Math.min(1.35, Math.max(0.05, Math.min((width - padding * 2) / contentWidth, (height - padding * 2) / contentHeight)));
  return {
    scale,
    x: width / 2 - (minX + contentWidth / 2) * scale,
    y: height / 2 - (minY + contentHeight / 2) * scale,
  };
}
