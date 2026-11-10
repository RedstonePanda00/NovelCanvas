import { memo, useLayoutEffect, useSyncExternalStore, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { ImageEditor } from './ImageEditor';
import { useI18n } from './i18n';
import {
  createNode, createEdge, edgeSemantics, fitViewport, nodeTypes, nowIso, semanticColors,
  type Viewport,
} from './project';
import { applyGenerationPlan } from './projectOperations';
import { WorkbenchDialog } from './WorkbenchDialog';
import { RelationshipPicker } from './RelationshipPicker';
import { relationshipLabels } from './relationships';
import { acceptVersion, addVersion, updateWorkbench } from './workbench';
import { useProjectStore } from './projectStore';
import type {
  AIGenerationPlan, CanvasEdge, CanvasNode, ContextPreviewResponse, EdgeSemantic, NodeType, Point,
  RagPreviewResponse, StructureWorkflow,
} from './types';

interface PointerInteraction {
  moved?: boolean;
  pointerId?: number;
  kind: 'pan' | 'node' | 'resize';
  startClient: Point;
  startViewport?: Viewport;
  panPreview?: Viewport;
  nodeId?: string;
  startPosition?: Point;
  startSize?: { width: number; height: number };
}

interface PendingCompletion {
  text: string;
  mode: 'replace' | 'append';
  kind: 'paragraph' | 'outline';
}

const viewportTransform = (view: Viewport) => `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function typeLabel(type: NodeType, locale: string) {
  if (locale === 'en') return type.replace('_', ' ');
  return ({
    paragraph: '段落', outline: '大纲', scene: '场景', character: '角色', supplemental_info: '补充资料',
    instruction: '指令', image: '图片', container: '章节 / 分组',
  } satisfies Record<NodeType, string>)[type];
}

function layoutPlan(plan: AIGenerationPlan, source: CanvasNode): AIGenerationPlan {
  const columnX = source.position.x + source.size.width + 180;
  const startY = source.position.y;
  return {
    ...plan,
    plannedNodes: plan.plannedNodes.map((node, index) => ({
      ...node,
      position: { x: columnX, y: startY + index * (Math.max(220, node.size.height) + 56) },
    })),
  };
}

type Drag = { id: string; changes: Partial<CanvasNode> };

function createDragPreview() {
  let current: Drag | null = null;
  const listeners = new Map<string, Set<() => void>>();
  return {
    get: (id: string) => current?.id === id ? current.changes : null,
    set(next: Drag | null) {
      const old = current;
      current = next;
      if (old && old.id !== next?.id) listeners.get(old.id)?.forEach(notify => notify());
      if (next) listeners.get(next.id)?.forEach(notify => notify());
    },
    subscribe(id: string, notify: () => void) {
      const entries = listeners.get(id) ?? new Set();
      entries.add(notify);
      listeners.set(id, entries);
      return () => { entries.delete(notify); if (!entries.size) listeners.delete(id); };
    },
  };
}
type DragPreview = ReturnType<typeof createDragPreview>;

function useDragNode(node: CanvasNode, preview: DragPreview) {
  const subscribe = useCallback((notify: () => void) => preview.subscribe(node.id, notify), [node.id, preview]);
  const changes = useSyncExternalStore(subscribe, () => preview.get(node.id));
  return changes ? { ...node, ...changes } : node;
}

const EdgePath = memo(function EdgePath({ edge, from, to, preview, pending, selected, locale, selectEdge }: {
  edge: CanvasEdge; from: CanvasNode; to: CanvasNode; preview: DragPreview; pending: boolean;
  selected: boolean; locale: string; selectEdge: (id: string) => void;
}) {
  const source = useDragNode(from, preview), target = useDragNode(to, preview);
  const sx = source.position.x + source.size.width; const sy = source.position.y + 44;
  const tx = target.position.x; const ty = target.position.y + 44;
  const bend = Math.max(80, Math.abs(tx - sx) * 0.45);
  const d = `M ${sx} ${sy} C ${sx + bend} ${sy}, ${tx - bend} ${ty}, ${tx} ${ty}`;
  return <g key={edge.id} className={`${selected ? 'selected' : ''} ${pending ? 'pending' : ''}`}>
    <path className="edge-hit" d={d} onClick={() => !pending && selectEdge(edge.id)} />
    <path className="edge-line" d={d} style={{ stroke: semanticColors[edge.semantic] }} markerEnd={`url(#arrow-${edge.semantic})`} />
    {selected ? <text x={(sx + tx) / 2} y={(sy + ty) / 2 - 8}>{relationshipLabels[edge.semantic][locale === 'zh-CN' ? 0 : 1]}</text> : null}
  </g>;
});

const NodeCard = memo(function NodeCard({ source, preview, pendingNode, selected, generating, hovered, busy,
  completion, candidateBody, onSelect, onCompare, onAccept, onReject, updateNode, interactionRef,
  connectionRef, setConnectSourceId, setConnectionPoint, screenToCanvas }: {
  source: CanvasNode; preview: DragPreview; pendingNode: boolean; selected: boolean; generating: boolean;
  hovered: boolean; busy: boolean; completion?: PendingCompletion; candidateBody?: string;
  onSelect: (node: CanvasNode) => void; onCompare: (id: string) => void;
  onAccept?: (node: CanvasNode) => void; onReject?: (id: string) => void;
  updateNode: (id: string, changes: Partial<CanvasNode>) => void;
  interactionRef: React.RefObject<PointerInteraction | null>; connectionRef: React.RefObject<string>;
  setConnectSourceId: (id: string) => void; setConnectionPoint: (point: Point) => void;
  screenToCanvas: (x: number, y: number) => Point;
}) {
  const { locale, t } = useI18n();
  const node = useDragNode(source, preview);
  const body = completion ? completion.text : candidateBody ?? node.body ?? '';
  return (
    <article key={node.id} data-node-id={node.id} className={`canvas-node type-border-${node.type} ${selected ? 'selected' : ''} ${pendingNode ? 'pending' : ''} ${generating ? 'generating' : ''} ${hovered ? 'connection-target' : ''}`}
      style={{ left: node.position.x, top: node.position.y, width: node.size.width, minHeight: node.size.height }}
      onPointerDown={(event) => event.stopPropagation()} onClick={() => { if (!pendingNode) { onSelect(node); } }}>
      <header className="node-header" onPointerDown={(event) => {
        if (pendingNode || event.button !== 0 || (event.target as HTMLElement).closest('input,button')) return;
        event.preventDefault();
        window.getSelection()?.removeAllRanges();
        document.body.classList.add('canvas-drag-active');
        interactionRef.current = { kind: 'node', nodeId: node.id, startClient: { x: event.clientX, y: event.clientY }, startPosition: node.position };
      }}>
        <span className={`node-type type-${node.type}`}><span className="type-dot" />{typeLabel(node.type, locale)}</span>
        <input aria-label={t('title')} value={node.title} disabled={Boolean(pendingNode)} onChange={(event) => updateNode(node.id, { title: event.target.value })} />
        {!pendingNode ? <button type="button" className="connection-handle output" aria-label={locale === 'zh-CN' ? '拖出关联' : 'Drag connection'} title={locale === 'zh-CN' ? '拖到目标节点建立关联；按回车后可点击目标' : 'Drag to a target node; Enter then click a target also works'} onPointerDown={(event) => { if (event.button !== 0) return; event.preventDefault(); event.stopPropagation(); connectionRef.current = node.id; setConnectSourceId(node.id); setConnectionPoint(screenToCanvas(event.clientX, event.clientY)); document.body.classList.add('canvas-drag-active'); event.currentTarget.setPointerCapture?.(event.pointerId); }} onClick={(event) => { event.stopPropagation(); if (event.detail === 0) setConnectSourceId(node.id); }}>↗</button> : null}
      </header>
      {node.type === 'image' ? <ImageEditor image={node.image} alt={body || node.title} disabled={pendingNode} onChange={image => updateNode(node.id, { image })} /> : null}
      <textarea aria-label={t('body')} value={body} disabled={Boolean(pendingNode || completion || candidateBody !== undefined || generating)} placeholder={node.type === 'image' ? (locale === 'zh-CN' ? '图片说明（用于检索和文字引用）' : 'Image description for search and text references') : t('body')} onChange={(event) => updateNode(node.id, { body: event.target.value })} />
      <input className="node-tags" aria-label={t('tags')} value={node.metadata.tags.join(', ')} disabled={Boolean(pendingNode)} placeholder={t('tags')} onChange={(event) => updateNode(node.id, { metadata: { ...node.metadata, tags: event.target.value.split(',').map((tag) => tag.trim()).filter(Boolean) } })} />
      {candidateBody !== undefined ? <div className="pending-actions"><span>{t('planReady')}</span><button type="button" onClick={() => onCompare(node.id)}>{locale === 'zh-CN' ? '对比候选' : 'Compare candidate'}</button><button type="button" onClick={() => onAccept?.(node)} disabled={busy}>{t('accept')}</button><button type="button" onClick={() => onReject?.(node.id)} disabled={busy}>{t('reject')}</button></div> : null}
      {!pendingNode ? <button type="button" className="resize-handle" aria-label={`Resize ${node.title}`} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); document.body.classList.add('canvas-drag-active'); interactionRef.current = { kind: 'resize', nodeId: node.id, startClient: { x: event.clientX, y: event.clientY }, startSize: node.size }; }} /> : null}
    </article>
  );
});

function MiniMap({ nodes, viewport, onFit }: { nodes: CanvasNode[]; viewport: Viewport; onFit: () => void }) {
  const { t } = useI18n();
  const bounds = useMemo(() => {
    if (!nodes.length) return null;
    const minX = Math.min(...nodes.map((node) => node.position.x));
    const minY = Math.min(...nodes.map((node) => node.position.y));
    const maxX = Math.max(...nodes.map((node) => node.position.x + node.size.width));
    const maxY = Math.max(...nodes.map((node) => node.position.y + node.size.height));
    return { minX, minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
  }, [nodes]);
  return (
    <button className="minimap" type="button" onClick={onFit} aria-label={t('minimap')} title={`${t('fitAll')} · ${Math.round(viewport.scale * 100)}%`}>
      {bounds ? nodes.map((node) => (
        <span key={node.id} style={{
          left: `${((node.position.x - bounds.minX) / bounds.width) * 100}%`,
          top: `${((node.position.y - bounds.minY) / bounds.height) * 100}%`,
          width: `${Math.max(3, (node.size.width / bounds.width) * 100)}%`,
          height: `${Math.max(3, (node.size.height / bounds.height) * 100)}%`,
        }} />
      )) : null}
    </button>
  );
}

export function CanvasWorkspace({ active = true }: { active?: boolean }) {
  const { t, locale } = useI18n();
  const {
    project, selectedNode, selectedEdge, selectedNodeId, selectedEdgeId, updateProject, selectNode, selectEdge,
    undo, redo, canUndo, canRedo, saveNow,
  } = useProjectStore();
  const stageRef = useRef<HTMLDivElement | null>(null);
  const interactionRef = useRef<PointerInteraction | null>(null);
  const suppressClickRef = useRef(false);
  const generationAbortRef = useRef<AbortController | null>(null);
  const dragRef = useRef<{ id: string; changes: Partial<CanvasNode> } | null>(null);
  const [dragPreview] = useState(createDragPreview);
  const worldRef = useRef<HTMLDivElement>(null);
  useEffect(() => () => { generationAbortRef.current?.abort(); }, []);
  const [viewport, setViewport] = useState<Viewport>({ x: 24, y: 24, scale: 1 });
  const viewportRef = useRef(viewport);
  useLayoutEffect(() => { viewportRef.current = viewport; }, [viewport]);
  const [placingType, setPlacingType] = useState<NodeType | null>(null);
  const [connectSourceId, setConnectSourceId] = useState('');
  const connectionRef = useRef<string>('');
  const [connectionPoint, setConnectionPoint] = useState<Point | null>(null);
  const [hoverTarget, setHoverTarget] = useState('');
  const [linkPair, setLinkPair] = useState<{ sourceId: string; targetId: string } | null>(null);
  const [candidateNodeId, setCandidateNodeId] = useState('');
  const candidateNode = candidateNodeId ? project?.nodes.find(node => node.id === candidateNodeId) : undefined;
  const candidateWork = project?.workbench?.[candidateNodeId];
  const inspectedCandidate = candidateWork?.versions.find((version) => version.id === candidateWork.activeVersionId);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<NodeType | ''>('');
  const [generationMode, setGenerationMode] = useState<'replace' | 'append'>('replace');
  const [sceneCount, setSceneCount] = useState(3);
  const [pendingPlan, setPendingPlan] = useState<AIGenerationPlan | null>(null);
  const [pendingCompletions, setPendingCompletions] = useState<Record<string, PendingCompletion>>({});
  const [generationTargetId, setGenerationTargetId] = useState('');
  const [notice, setNotice] = useState('');
  const [contextPreview, setContextPreview] = useState<ContextPreviewResponse | null>(null);
  const [memoryPreview, setMemoryPreview] = useState<RagPreviewResponse | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const previewRevision = useRef(0);
  useEffect(() => {
    previewRevision.current += 1;
    setContextPreview(null);
    setMemoryPreview(null);
    setPreviewBusy(false);
  }, [selectedNodeId, project]);


  const canvasNodes = useMemo(() => pendingPlan ? [...(project?.nodes ?? []), ...pendingPlan.plannedNodes] : project?.nodes ?? [], [pendingPlan, project?.nodes]);
  const canvasEdges = useMemo(() => pendingPlan ? [...(project?.edges ?? []), ...pendingPlan.plannedEdges] : project?.edges ?? [], [pendingPlan, project?.edges]);
  const nodeById = useMemo(() => new Map(canvasNodes.map((node) => [node.id, node])), [canvasNodes]);
  const adjacency = useMemo(() => {
    const map = new Map<string, { incoming: CanvasEdge[]; outgoing: CanvasEdge[] }>();
    function links(id: string) {
      let entry = map.get(id);
      if (!entry) { entry = { incoming: [], outgoing: [] }; map.set(id, entry); }
      return entry;
    }
    for (const edge of project?.edges ?? []) {
      links(edge.targetNodeId).incoming.push(edge);
      links(edge.sourceNodeId).outgoing.push(edge);
    }
    return map;
  }, [project?.edges]);

  const filteredNodes = useMemo(() => {
    const nodes = project?.nodes ?? [];
    const needle = search.trim().toLowerCase();
    if (!typeFilter && !needle) return nodes;
    return nodes.filter(node => (!typeFilter || node.type === typeFilter) &&
      (!needle || `${node.title} ${node.body ?? ''} ${node.metadata.tags.join(' ')}`.toLowerCase().includes(needle)));
  }, [project?.nodes, search, typeFilter]);

  const fitAll = useCallback((nodes = canvasNodes) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    setViewport(fitViewport(nodes, rect.width, rect.height));
  }, [canvasNodes]);

  const centerNode = useCallback((node: CanvasNode) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    setViewport((current) => ({
      ...current,
      x: rect.width / 2 - (node.position.x + node.size.width / 2) * current.scale,
      y: rect.height / 2 - (node.position.y + node.size.height / 2) * current.scale,
    }));
    selectNode(node.id);
  }, [selectNode]);

  useEffect(() => {
    if (!project) return;
    const key = `novel-canvas-viewport:${project.createdAt || project.title}`;
    const saved = localStorage.getItem(key);
    if (saved) {
      try { setViewport(JSON.parse(saved) as Viewport); return; } catch { /* use fit */ }
    }
    window.requestAnimationFrame(() => fitAll(project.nodes));
  // Fit only when a different project is opened.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.createdAt]);

  useEffect(() => {
    if (!project) return;
    const key = `novel-canvas-viewport:${project.createdAt || project.title}`;
    const timeout = window.setTimeout(() => localStorage.setItem(key, JSON.stringify(viewport)), 250);
    return () => window.clearTimeout(timeout);
  }, [project, viewport]);

  const screenToCanvas = useCallback((clientX: number, clientY: number): Point => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    const viewport = viewportRef.current;
    return { x: (clientX - rect.left - viewport.x) / viewport.scale, y: (clientY - rect.top - viewport.y) / viewport.scale };
  }, []);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!connectionRef.current) return;
      event.preventDefault();
      suppressClickRef.current = true;
      setConnectionPoint(screenToCanvas(event.clientX, event.clientY));
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('.canvas-node:not(.pending)');
      setHoverTarget(target?.dataset.nodeId ?? '');
    };
    const up = (event: PointerEvent) => {
      const sourceId = connectionRef.current;
      if (!sourceId) return;
      const targetId = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('.canvas-node:not(.pending)')?.dataset.nodeId;
      if (targetId && targetId !== sourceId) setLinkPair({ sourceId, targetId });
      connectionRef.current = ''; setConnectSourceId(''); setConnectionPoint(null); setHoverTarget('');
      document.body.classList.remove('canvas-drag-active');
    };
    const cancel = () => { connectionRef.current = ''; setConnectSourceId(''); setConnectionPoint(null); setHoverTarget(''); document.body.classList.remove('canvas-drag-active'); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancel); window.addEventListener('blur', cancel);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel); window.removeEventListener('blur', cancel); };
  }, [screenToCanvas]);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const interaction = interactionRef.current;
      if (!interaction) return;
      if (interaction.pointerId !== undefined && event.pointerId !== interaction.pointerId) return;
      if (Math.hypot(event.clientX - interaction.startClient.x, event.clientY - interaction.startClient.y) < 3 && !interaction.moved) return;
      interaction.moved = true;
      suppressClickRef.current = true;
      event.preventDefault();
      if (interaction.kind === 'pan' && interaction.startViewport) {
        const view = { ...interaction.startViewport, x: interaction.startViewport.x + event.clientX - interaction.startClient.x, y: interaction.startViewport.y + event.clientY - interaction.startClient.y };
        interaction.panPreview = view;
        if (worldRef.current) worldRef.current.style.transform = viewportTransform(view);
      }
      if (interaction.kind === 'node' && interaction.nodeId && interaction.startPosition) {
        const position = {
          x: interaction.startPosition.x + (event.clientX - interaction.startClient.x) / viewport.scale,
          y: interaction.startPosition.y + (event.clientY - interaction.startClient.y) / viewport.scale,
        };
        dragRef.current = { id: interaction.nodeId, changes: { position } };
        dragPreview.set(dragRef.current);
      }
      if (interaction.kind === 'resize' && interaction.nodeId && interaction.startSize) {
        const size = {
          width: clamp(interaction.startSize.width + (event.clientX - interaction.startClient.x) / viewport.scale, 240, 720),
          height: clamp(interaction.startSize.height + (event.clientY - interaction.startClient.y) / viewport.scale, 180, 900),
        };
        dragRef.current = { id: interaction.nodeId, changes: { size } };
        dragPreview.set(dragRef.current);
      }
    };
    const up = () => {
      if (interactionRef.current?.panPreview) setViewport(interactionRef.current.panPreview);
      const drag = dragRef.current;
      if (drag) updateProject((current) => ({ ...current, nodes: current.nodes.map((node) => node.id === drag.id ? { ...node, ...drag.changes, metadata: { ...node.metadata, updatedAt: nowIso() } } : node) }));
      dragRef.current = null;
      dragPreview.set(null);
      interactionRef.current = null;
      document.body.classList.remove('canvas-drag-active');
      const stage = stageRef.current;
      if (stage) stage.classList.remove('panning');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('blur', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('blur', up);
      document.body.classList.remove('canvas-drag-active');
    };
  }, [dragPreview, updateProject, viewport.scale]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!active && !((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's')) return;
      const editing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void saveNow(); }
      if (!editing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); }
      if (!editing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); }
      if (!editing && event.key.toLowerCase() === 'f') fitAll();
      if (event.key === 'Escape') { connectionRef.current = ''; setConnectionPoint(null); setHoverTarget(''); setLinkPair(null); setConnectSourceId(''); setPlacingType(null); document.body.classList.remove('canvas-drag-active'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, fitAll, redo, saveNow, undo]);



  const updateNode = useCallback((nodeId: string, changes: Partial<CanvasNode>) => updateProject((current) => ({
    ...current,
    nodes: current.nodes.map((node) => node.id === nodeId ? { ...node, ...changes, metadata: { ...(changes.metadata ?? node.metadata), updatedAt: nowIso() } } : node),
  })), [updateProject]);

  const onNodeSelect = useCallback((target: CanvasNode) => {
    if (!connectSourceId) { selectNode(target.id); return; }
    if (target.id !== connectSourceId) {
      setLinkPair({ sourceId: connectSourceId, targetId: target.id });
      setConnectSourceId('');
    }
  }, [connectSourceId, selectNode]);

  if (!project) return <section className="empty-state">{t('loading')}</section>;

  const addNode = (type: NodeType, position: Point) => {
    const node = createNode(type, project.nodes.length, position);
    updateProject((current) => ({ ...current, nodes: [...current.nodes, node] }));
    selectNode(node.id);
    setPlacingType(null);
  };

  const deleteNode = (node: CanvasNode) => {
    if (!window.confirm(t('confirmDeleteNode'))) return;
    updateProject((current) => ({
      ...current,
      nodes: current.nodes.filter(item => item.id !== node.id).map(item => item.childNodeIds.includes(node.id) ? { ...item, childNodeIds: item.childNodeIds.filter(id => id !== node.id) } : item),
      edges: current.edges.filter((edge) => edge.sourceNodeId !== node.id && edge.targetNodeId !== node.id),
    }));
    selectNode('');
  };

  const refreshContext = async () => {
    if (!selectedNode) return;
    const revision = ++previewRevision.current;
    setPreviewBusy(true);
    setNotice('');
    try {
      const preview = await api.previewContext(project, selectedNode.id);
      if (revision !== previewRevision.current) return;
      setContextPreview(preview);
      setMemoryPreview(null);
    } catch (error) { if (revision === previewRevision.current) setNotice(error instanceof Error ? error.message : t('generationFailed')); }
    finally { if (revision === previewRevision.current) setPreviewBusy(false); }
  };

  const refreshMemory = async () => {
    if (!selectedNode || selectedNode.type !== 'paragraph') return;
    const revision = ++previewRevision.current;
    setPreviewBusy(true);
    try { const preview = await api.previewMemory(project, selectedNode.id); if (revision === previewRevision.current) setMemoryPreview(preview); }
    catch (error) { if (revision === previewRevision.current) setNotice(error instanceof Error ? error.message : t('generationFailed')); }
    finally { if (revision === previewRevision.current) setPreviewBusy(false); }
  };

  const runTextGeneration = async (kind: PendingCompletion['kind']) => {
    if (!selectedNode || generationTargetId || pendingPlan || pendingCompletions[selectedNode.id]) return;
    const controller = new AbortController();
    const mode = kind === 'paragraph' ? generationMode : 'replace';
    const pending: PendingCompletion = { text: '', mode, kind };
    generationAbortRef.current = controller;
    setGenerationTargetId(selectedNode.id);
    setPendingCompletions((current) => ({ ...current, [selectedNode.id]: pending }));
    setNotice(t('generating'));
    let text = '';
    const onChunk = (chunk: string) => {
      text += chunk;
      setPendingCompletions((current) => ({ ...current, [selectedNode.id]: { ...pending, text } }));
    };
    try {
      if (kind === 'paragraph') await api.streamParagraphGeneration(project, selectedNode.id, mode, onChunk, controller.signal);
      if (kind === 'outline') await api.streamNodeCompletion(project, selectedNode.id, onChunk, controller.signal);
      if (controller.signal.aborted) return;
      if (!text.trim()) throw new Error('Empty generation result');
      const baseBody = selectedNode.body ?? '';
      updateProject((current) => addVersion(current, selectedNode.id, {
        id: crypto.randomUUID(), title: selectedNode.title, nodeType: selectedNode.type,
        body: mode === 'append' && baseBody.trim() ? `${baseBody}\n\n${text}` : text,
        baseBody, feedback: `${kind} · ${mode}`, preserve: '', rationale: '',
        operation: 'replace', status: 'pending', createdAt: nowIso(),
      }), false);
      setNotice(t('planReady'));
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') setNotice(t('streamCanceled'));
      else setNotice(`${t('generationFailed')}: ${error instanceof Error ? error.message : ''}`);
    } finally {
      setPendingCompletions((current) => { const next = { ...current }; delete next[selectedNode.id]; return next; });
      generationAbortRef.current = null;
      setGenerationTargetId('');
    }
  };

  const acceptCompletion = (node: CanvasNode) => {
    const id = project.workbench?.[node.id]?.activeVersionId;
    if (!id) return;
    try { const next = acceptVersion(project, node.id, id); updateProject(() => next); } catch (e) { setNotice(String(e)); }
  };

  const rejectCompletion = (nodeId: string) => updateProject((current) => updateWorkbench(current, nodeId, (state) => ({ ...state, versions: state.versions.map((version) => version.id === state.activeVersionId ? { ...version, status: 'rejected' } : version) })), false);

  const sourceIdsFor = (node: CanvasNode, workflow: StructureWorkflow) => {
    if (workflow === 'generate-scenes' || workflow === 'generate-outline') {
      const references = (adjacency.get(node.id)?.incoming ?? []).filter((edge) => edge.semantic === 'reference').map((edge) => edge.sourceNodeId);
      return Array.from(new Set([node.id, ...references]));
    }
    return [node.id];
  };

  const runPlan = async (workflow: StructureWorkflow) => {
    if (!selectedNode || generationTargetId || pendingPlan || pendingCompletions[selectedNode.id]) return;
    const controller = new AbortController();
    generationAbortRef.current = controller;
    setGenerationTargetId(selectedNode.id);
    setNotice(t('generating'));
    try {
      if (workflow === 'generate-scenes') {
        const timestamp = nowIso(); const id = `plan-${crypto.randomUUID()}`;
        const nodes = Array.from({ length: sceneCount }, (_, index) => {
          const created = createNode('scene', index, selectedNode.position);
          return { ...created, title: `${locale === 'zh-CN' ? '场景' : 'Scene'} ${index + 1} · …`, metadata: { ...created.metadata, sourceNodeIds: [selectedNode.id], generatedByWorkflow: workflow, generatedPlanId: id, tags: ['draft', 'ai'] } };
        });
        const initial = layoutPlan({ id, workflow, sourceNodeIds: [selectedNode.id], plannedNodes: nodes, plannedEdges: nodes.map((node) => createEdge(selectedNode.id, node.id)), createdAt: timestamp, replacedNodeIds: [] }, selectedNode);
        setPendingPlan(initial); fitAll([selectedNode, ...initial.plannedNodes]);
        const fill = (drafts: Array<{ title: string; body: string }>) => setPendingPlan((current) => current?.id === id ? { ...current, plannedNodes: current.plannedNodes.map((node, index) => drafts[index] ? { ...node, title: drafts[index].title || node.title, body: drafts[index].body } : node) } : current);
        const drafts = await api.streamScenes(project, sourceIdsFor(selectedNode, workflow), sceneCount, fill, controller.signal);
        if (controller.signal.aborted) throw new DOMException('Canceled', 'AbortError');
        fill(drafts);
      } else {
        const plan = await api.generateStructurePlan(project, workflow, sourceIdsFor(selectedNode, workflow), null, controller.signal);
        setPendingPlan(layoutPlan(plan, selectedNode));
      }
      setNotice(t('planReady'));
    } catch (error) {
      if (workflow === 'generate-scenes') setPendingPlan(null);
      if (error instanceof DOMException && error.name === 'AbortError') setNotice(t('streamCanceled'));
      else setNotice(`${t('generationFailed')}: ${error instanceof Error ? error.message : ''}`);
    } finally { generationAbortRef.current = null; setGenerationTargetId(''); }
  };

  const acceptPlan = () => {
    if (!pendingPlan || generationTargetId) return;
    try {
      const next = applyGenerationPlan(project, pendingPlan);
      updateProject(() => next);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t('generationFailed'));
      return;
    }
    selectNode(pendingPlan.plannedNodes[0]?.id ?? '');
    setPendingPlan(null);
  };

  const addContainerChild = (childId: string) => {
    if (!selectedNode || selectedNode.type !== 'container' || !childId || selectedNode.childNodeIds.includes(childId)) return;
    const reachesSelected = (nodeId: string, seen = new Set<string>()): boolean => {
      if (nodeId === selectedNode.id) return true;
      if (seen.has(nodeId)) return false;
      seen.add(nodeId);
      const node = project.nodes.find((item) => item.id === nodeId);
      return Boolean(node?.childNodeIds.some((id) => reachesSelected(id, seen)));
    };
    if (reachesSelected(childId)) {
      setNotice('Container hierarchy cannot contain a cycle.');
      return;
    }
    updateNode(selectedNode.id, { childNodeIds: [...selectedNode.childNodeIds, childId] });
  };

  const moveContainerChild = (childId: string, delta: number) => {
    if (!selectedNode || selectedNode.type !== 'container') return;
    const list = [...selectedNode.childNodeIds];
    const index = list.indexOf(childId);
    const next = index + delta;
    if (index < 0 || next < 0 || next >= list.length) return;
    [list[index], list[next]] = [list[next], list[index]];
    updateNode(selectedNode.id, { childNodeIds: list });
  };

  return (
    <section className="canvas-workspace">
      <aside className="node-navigator">
        <div className="dock-heading"><div><span className="eyebrow">{t('canvas')}</span><h2>{t('navigator')}</h2></div></div>
        <div className="node-palette" aria-label={t('nodes')}>
          {nodeTypes.map((type) => (
            <button key={type} type="button" draggable onDragStart={(event) => event.dataTransfer.setData('application/x-novel-node', type)}
              className={placingType === type ? 'active' : ''} onClick={() => setPlacingType((current) => current === type ? null : type)}>
              <span className={`type-dot type-${type}`} /><span className="node-type-label">{typeLabel(type, locale)}</span>
            </button>
          ))}
        </div>
        <p className="helper-text">{t('addNodeHint')}</p>
        <div className="navigator-filters">
          <input aria-label={t('searchNodes')} placeholder={t('searchNodes')} value={search} onChange={(event) => setSearch(event.target.value)} />
          <select aria-label={t('type')} value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as NodeType | '')}>
            <option value="">{t('allTypes')}</option>
            {nodeTypes.map((type) => <option key={type} value={type}>{typeLabel(type, locale)}</option>)}
          </select>
        </div>
        <div className="navigator-list">
          {filteredNodes.map((node) => {
            const links = adjacency.get(node.id);
            return (
              <button type="button" key={node.id} className={selectedNodeId === node.id ? 'selected' : ''} onClick={() => centerNode(node)}>
                <span className={`type-dot type-${node.type}`} /><span><strong>{node.title || typeLabel(node.type, locale)}</strong><small>{typeLabel(node.type, locale)} · {links?.incoming.length ?? 0}↓ {links?.outgoing.length ?? 0}↑</small></span>
              </button>
            );
          })}
        </div>
      </aside>

      <div className="canvas-column">
        <div className="canvas-commandbar">
          <div className="button-group">
            <button type="button" className="icon-button" disabled={!canUndo} onClick={undo} title={t('undo')}>↶</button>
            <button type="button" className="icon-button" disabled={!canRedo} onClick={redo} title={t('redo')}>↷</button>
          </div>
          <div className="button-group">
            <button type="button" onClick={() => fitAll()}>{t('fitAll')}</button>
            <button type="button" disabled={!selectedNode} onClick={() => selectedNode && fitAll([selectedNode])}>{t('fitSelection')}</button>
          </div>
          {connectSourceId ? <span className="connection-notice">{t('connectionEnd')}</span> : placingType ? <span className="connection-notice">{t('addNodeHint')}</span> : null}
          <span className="zoom-readout">{Math.round(viewport.scale * 100)}%</span>
        </div>
        <div ref={stageRef} className={`canvas-stage ${placingType ? 'placing' : ''}`}
          onPointerDownCapture={() => { suppressClickRef.current = false; }}
          onClickCapture={(event) => {
            if (!suppressClickRef.current) return;
            suppressClickRef.current = false;
            event.preventDefault();
            event.stopPropagation();
          }}
          onPointerDown={(event) => {
            const target = event.target as HTMLElement;
            if (event.button !== 0 || target.closest('.canvas-node, .canvas-floating-controls, .minimap, .edge-hit')) return;
            event.preventDefault();
            if (placingType) { addNode(placingType, screenToCanvas(event.clientX, event.clientY)); return; }
            window.getSelection()?.removeAllRanges();
            document.body.classList.add('canvas-drag-active');
            event.currentTarget.classList.add('panning');
            event.currentTarget.setPointerCapture?.(event.pointerId);
            interactionRef.current = { kind: 'pan', pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startViewport: viewport };
          }}
          onClick={(event) => {
            if (!(event.target as Element).closest('.canvas-node, .canvas-floating-controls, .minimap, .edge-hit')) selectNode('');
          }}
          onWheel={(event) => {
            if ((event.target as HTMLElement).closest('textarea, input, select')) return;
            event.preventDefault();
            const rect = stageRef.current?.getBoundingClientRect();
            if (!rect) return;
            const point = screenToCanvas(event.clientX, event.clientY);
            const scale = clamp(viewport.scale * (event.deltaY < 0 ? 1.1 : 0.9), 0.05, 2.2);
            setViewport({ scale, x: event.clientX - rect.left - point.x * scale, y: event.clientY - rect.top - point.y * scale });
          }}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            const type = event.dataTransfer.getData('application/x-novel-node') as NodeType;
            if (nodeTypes.includes(type)) addNode(type, screenToCanvas(event.clientX, event.clientY));
          }}>
          <div className="canvas-floating-controls">
            <button type="button" aria-label={t('zoomOut')} onClick={() => setViewport((value) => ({ ...value, scale: clamp(value.scale / 1.12, 0.05, 2.2) }))}>−</button>
            <button type="button" aria-label={t('zoomIn')} onClick={() => setViewport((value) => ({ ...value, scale: clamp(value.scale * 1.12, 0.05, 2.2) }))}>+</button>
          </div>
          <div ref={worldRef} className="canvas-world" style={{ transform: viewportTransform(viewport) }}>
            <svg className="edge-layer" viewBox="-10000 -10000 20000 20000" aria-label={t('relationships')}>
              {connectSourceId && connectionPoint && nodeById.get(connectSourceId) && <path className="connection-preview" d={`M ${nodeById.get(connectSourceId)!.position.x + nodeById.get(connectSourceId)!.size.width} ${nodeById.get(connectSourceId)!.position.y + 44} L ${connectionPoint.x} ${connectionPoint.y}`} />}
              <defs>{edgeSemantics.map((semantic) => <marker key={semantic} id={`arrow-${semantic}`} markerWidth="10" markerHeight="10" refX="9" refY="4" orient="auto"><path d="M0,0 L9,4 L0,8 Z" fill={semanticColors[semantic]} /></marker>)}</defs>
              {canvasEdges.map((edge) => {
                const source = nodeById.get(edge.sourceNodeId); const target = nodeById.get(edge.targetNodeId);
                if (!source || !target) return null;
                return <EdgePath key={edge.id} edge={edge} from={source} to={target} preview={dragPreview}
                  selected={selectedEdgeId === edge.id} pending={Boolean(pendingPlan?.plannedEdges.some(item => item.id === edge.id))}
                  locale={locale} selectEdge={selectEdge} />;
              })}
            </svg>
            {canvasNodes.map((node) => {
              const pendingNode = pendingPlan?.plannedNodes.some((item) => item.id === node.id);
              const completion = pendingCompletions[node.id];
              const work = project.workbench?.[node.id];
              const candidate = work?.versions.find((version) => version.id === work.activeVersionId && version.status === 'pending' && version.operation === 'replace');
              return <NodeCard key={node.id} source={node} preview={dragPreview} pendingNode={Boolean(pendingNode)}
                selected={selectedNodeId === node.id} generating={generationTargetId === node.id}
                hovered={hoverTarget === node.id && connectSourceId !== node.id} busy={Boolean(candidate && generationTargetId)}
                completion={completion} candidateBody={candidate?.body} onSelect={onNodeSelect} onCompare={setCandidateNodeId}
                onAccept={candidate ? acceptCompletion : undefined} onReject={candidate ? rejectCompletion : undefined}
                updateNode={updateNode} interactionRef={interactionRef} connectionRef={connectionRef}
                setConnectSourceId={setConnectSourceId} setConnectionPoint={setConnectionPoint} screenToCanvas={screenToCanvas} />;
            })}
          </div>
          {!canvasNodes.length ? <div className="canvas-empty"><strong>{t('emptyCanvas')}</strong><span>{t('addNodeHint')}</span></div> : null}
          <MiniMap nodes={canvasNodes} viewport={viewport} onFit={() => fitAll()} />
        </div>
      </div>

      <aside className="inspector-panel">
        <div className="inspector-details">
        <div className="dock-heading"><div><span className="eyebrow">{t('canvas')}</span><h2>{t('inspector')}</h2></div></div>
        {selectedNode ? <>
          <section className="inspector-section"><RelationshipPicker key={selectedNode.id} targetId={selectedNode.id} /></section>
          <section className="inspector-section node-summary"><span className={`node-type type-${selectedNode.type}`}><span className="type-dot" />{typeLabel(selectedNode.type, locale)}</span><h3>{selectedNode.title}</h3><p>{selectedNode.body?.slice(0, 180) || t('body')}</p></section>
          <section className="inspector-section"><h3>{t('relationships')}</h3>
            {[...(adjacency.get(selectedNode.id)?.incoming ?? []), ...(adjacency.get(selectedNode.id)?.outgoing ?? [])].map((edge) => {
              const incoming = edge.targetNodeId === selectedNode.id;
              const other = nodeById.get(incoming ? edge.sourceNodeId : edge.targetNodeId);
              return <button type="button" className="relationship-chip" key={edge.id} onClick={() => selectEdge(edge.id)}><span style={{ background: semanticColors[edge.semantic] }} />{incoming ? '↓' : '↑'} {other?.title ?? 'Missing'}<small>{relationshipLabels[edge.semantic][locale === 'zh-CN' ? 0 : 1]}</small></button>;
            })}
            {!adjacency.get(selectedNode.id)?.incoming.length && !adjacency.get(selectedNode.id)?.outgoing.length ? <p className="helper-text">{t('contextEmpty')}</p> : null}
          </section>
          {selectedNode.type === 'container' ? <section className="inspector-section"><h3>{t('childNodes')}</h3>
            <select aria-label={t('addChild')} defaultValue="" onChange={(event) => { addContainerChild(event.target.value); event.target.value = ''; }}><option value="">{t('addChild')}</option>{project.nodes.filter((node) => node.id !== selectedNode.id && !selectedNode.childNodeIds.includes(node.id)).map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}</select>
            <div className="child-list">{selectedNode.childNodeIds.map((id, index) => <div key={id}><span>{project.nodes.find((node) => node.id === id)?.title ?? id}</span><button type="button" disabled={index === 0} onClick={() => moveContainerChild(id, -1)}>↑</button><button type="button" disabled={index === selectedNode.childNodeIds.length - 1} onClick={() => moveContainerChild(id, 1)}>↓</button><button type="button" onClick={() => updateNode(selectedNode.id, { childNodeIds: selectedNode.childNodeIds.filter((childId) => childId !== id) })}>×</button></div>)}</div>
          </section> : null}
          <section className="inspector-section"><div className="section-title"><h3>{t('contextPreview')}</h3><button type="button" onClick={() => void refreshContext()} disabled={previewBusy}>{t('refresh')}</button></div>
            {contextPreview?.memoryStale ? <div className="warning-callout">{t('staleMemory')}</div> : null}
            {contextPreview?.items.map((item) => <div key={item.edgeId} className="context-row"><span style={{ background: semanticColors[item.semantic] }} /><strong>{item.title}</strong><small>{item.semantic} · {item.estimatedTokens} {t('tokens')}</small></div>)}
            {contextPreview && !contextPreview.items.length ? <p className="helper-text">{t('contextEmpty')}</p> : null}
            {selectedNode.type === 'paragraph' ? <button type="button" className="secondary" onClick={() => void refreshMemory()} disabled={previewBusy}>{t('memory')} · {t('refresh')}</button> : null}
            {memoryPreview?.stale ? <div className="warning-callout">{t('staleMemory')}</div> : null}
            {memoryPreview?.snippets.map((snippet) => <div key={snippet.chunkId} className="memory-snippet"><strong>{snippet.documentTitle}</strong><small>{snippet.score.toFixed(3)}</small><p>{snippet.text}</p></div>)}
          </section>
          <section className="inspector-section"><h3>{t('aiWorkflow')}</h3>
            {selectedNode.type === 'paragraph' ? <label>{t('exportMode')}<select value={generationMode} onChange={(event) => setGenerationMode(event.target.value as 'replace' | 'append')}><option value="replace">{t('replace')}</option><option value="append">{t('append')}</option></select></label> : null}
            {selectedNode.type === 'outline' ? <label>{t('sceneCount')}<input type="number" min="1" max="12" step="1" value={sceneCount} onChange={(event) => setSceneCount(clamp(Math.floor(Number(event.target.value) || 1), 1, 12))} /></label> : null}
            <div className="workflow-grid">
              {['character', 'supplemental_info', 'instruction', 'container'].includes(selectedNode.type) ? <button type="button" onClick={() => void runPlan('generate-outline')}>{t('generateOutline')}</button> : null}
              {selectedNode.type === 'outline' ? <><button type="button" onClick={() => void runTextGeneration('outline')}>{t('completeOutline')}</button><button type="button" onClick={() => void runPlan('generate-scenes')}>{t('generateScenes')}</button></> : null}
              {selectedNode.type === 'scene' ? <><button type="button" onClick={() => void runPlan('generate-next-scene')}>{t('nextScene')}</button><button type="button" onClick={() => void runPlan('split-scene')}>{t('splitScene')}</button><button type="button" onClick={() => void runPlan('generate-paragraph-tasks')}>{t('paragraphTask')}</button></> : null}
              {selectedNode.type === 'paragraph' ? <><button type="button" onClick={() => void runTextGeneration('paragraph')}>{t('generateParagraph')}</button></> : null}
            </div>
            {generationTargetId ? <button type="button" className="danger" onClick={() => generationAbortRef.current?.abort()}>{t('cancel')}</button> : null}
          </section>
          <section className="inspector-section danger-zone"><button type="button" className="danger" onClick={() => deleteNode(selectedNode)}>{t('deleteNode')}</button></section>
        </> : selectedEdge ? <>
          <section className="inspector-section"><h3>{t('relationshipSemantic')}</h3><select value={selectedEdge.semantic} onChange={(event) => updateProject((current) => ({ ...current, edges: current.edges.map((edge) => edge.id === selectedEdge.id ? { ...edge, semantic: event.target.value as EdgeSemantic, label: event.target.value } : edge) }))}>{edgeSemantics.map((semantic) => <option key={semantic} value={semantic}>{relationshipLabels[semantic][locale === 'zh-CN' ? 0 : 1]}</option>)}</select><p>{relationshipLabels[selectedEdge.semantic][locale === 'zh-CN' ? 2 : 3]}</p></section>
          <section className="inspector-section danger-zone"><button type="button" className="danger" onClick={() => { if (window.confirm(t('confirmDeleteEdge'))) updateProject((current) => ({ ...current, edges: current.edges.filter((edge) => edge.id !== selectedEdge.id) })); }}>{t('deleteEdge')}</button></section>
        </> : <div className="inspector-empty"><span>◇</span><p>{t('noSelection')}</p></div>}
        </div>
      </aside>
      {candidateNode && inspectedCandidate && <WorkbenchDialog className="version-dialog" label={locale === 'zh-CN' ? '生成候选对比' : 'Generation candidate comparison'} onClose={() => setCandidateNodeId('')}>
        <header><h2>{candidateNode.title}</h2><button onClick={() => setCandidateNodeId('')}>{locale === 'zh-CN' ? '关闭' : 'Close'}</button></header>
        <div className="version-comparison"><pre>{inspectedCandidate.baseBody}</pre><pre>{inspectedCandidate.body}</pre></div>
        <button disabled={inspectedCandidate.status !== 'pending' || Boolean(generationTargetId)} onClick={() => acceptCompletion(candidateNode)}>{t('accept')}</button>
      </WorkbenchDialog>}
      {linkPair && <WorkbenchDialog className="link-dialog" label={locale === 'zh-CN' ? '确认关联' : 'Confirm relationship'} onClose={() => setLinkPair(null)}><RelationshipPicker key={`${linkPair.sourceId}:${linkPair.targetId}`} {...linkPair} onClose={() => setLinkPair(null)} /></WorkbenchDialog>}
      {pendingPlan ? <div className="plan-review-bar"><div><strong>{t('pendingPlan')}</strong><span>{pendingPlan.plannedNodes.length} {t('nodes')} · {pendingPlan.plannedEdges.length} {t('relationships')}</span></div><button type="button" disabled={Boolean(generationTargetId)} onClick={acceptPlan}>{t('accept')}</button><button type="button" className="secondary" disabled={Boolean(generationTargetId)} onClick={() => setPendingPlan(null)}>{t('reject')}</button></div> : null}
      <div className="live-notice" role="status" aria-live="polite">{notice}</div>
    </section>
  );
}
