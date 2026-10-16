import type { AgentMutation, AgentPreconditions, CanvasEdge, CanvasNode, DraftVersion, ProjectFile, WorldbookEntry } from './types';
import { acceptVersion, rollbackVersion, updateWorkbench } from './workbench';

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).filter(([, v]) => v != null).sort(([a], [b]) => a.localeCompare(b))) : item ?? null);

function currentValue(project: ProjectFile, change: AgentMutation): unknown {
  if (change.kind === 'edge') return project.edges.find((e) => e.id === change.targetId) ?? null;
  if (change.kind === 'worldbook') return project.worldbook.entries.find((e) => e.id === change.targetId) ?? null;
  const node = project.nodes.find((n) => n.id === change.targetId);
  if (change.kind === 'node_delete') return node ?? null;
  return node ? { id: node.id, childNodeIds: node.childNodeIds, sourceNodeIds: node.metadata.sourceNodeIds } : null;
}

function mutate(project: ProjectFile, change: AgentMutation, reverse = false): ProjectFile {
  const expected = reverse ? change.after : change.before;
  const replacement = reverse ? change.before : change.after;
  if (canonical(currentValue(project, change)) !== canonical(expected)) throw new Error('作品有后续修改，整批操作未执行 / Affected project data changed; the batch was not applied.');
  if (replacement && replacement.id !== change.targetId) throw new Error('Invalid mutation identity.');
  const replace = <T extends { id: string }>(items: T[]) => {
    if (!replacement) return items.filter((item) => item.id !== change.targetId);
    if (items.some((item) => item.id === change.targetId)) return items.map((item) => item.id === change.targetId ? replacement as unknown as T : item);
    const next = [...items];
    next.splice(reverse && change.index != null ? change.index : next.length, 0, replacement as unknown as T);
    return next;
  };
  if (change.kind === 'edge') return { ...project, edges: replace<CanvasEdge>(project.edges) };
  if (change.kind === 'worldbook') return { ...project, worldbook: { ...project.worldbook, entries: replace<WorldbookEntry>(project.worldbook.entries) } };
  if (change.kind === 'node_delete') return { ...project, nodes: replace<CanvasNode>(project.nodes) };
  if (!replacement) throw new Error('Node relationship update must contain its new state.');
  return { ...project, nodes: project.nodes.map((node) => node.id === change.targetId ? { ...node,
    childNodeIds: replacement.childNodeIds as string[], metadata: { ...node.metadata, sourceNodeIds: replacement.sourceNodeIds as string[] } } : node) };
}

function validateGraph(project: ProjectFile) {
  const ids = new Set(project.nodes.map((node) => node.id));
  if (ids.size !== project.nodes.length || new Set(project.edges.map((edge) => edge.id)).size !== project.edges.length) throw new Error('Duplicate graph identity.');
  if (project.edges.some((edge) => !ids.has(edge.sourceNodeId) || !ids.has(edge.targetNodeId))) throw new Error('Relationship endpoint is missing.');
  if (project.nodes.some((node) => node.childNodeIds.some((id) => !ids.has(id)))) throw new Error('Child node is missing.');
}

/** Validate and commit the entire text/structure/canon batch or retain it as pending. */
export function applyAgentTransaction(project: ProjectFile, drafts: DraftVersion[], mutations: AgentMutation[], ownerId: string, preconditions?: AgentPreconditions): ProjectFile {
  if (!drafts.length && !mutations.length) return project;
  const pending = updateWorkbench(project, ownerId, (work) => ({ ...work, versions: drafts,
    activeVersionId: drafts[drafts.length - 1]?.id ?? null, mutations, agentPreconditions: preconditions ?? null }));
  try {
    for (const expected of preconditions?.nodes ?? []) {
      const node = project.nodes.find((item) => item.id === expected.id);
      const actual = node ? { id: node.id, type: node.type, title: node.title, body: node.body, childNodeIds: node.childNodeIds,
        narrativeTask: node.narrativeTask, targetWordCount: node.targetWordCount, outlineLevel: node.outlineLevel,
        sourceNodeIds: node.metadata.sourceNodeIds, tags: node.metadata.tags } : null;
      if (canonical(actual) !== canonical(expected)) throw new Error('已读取的节点在生成期间发生变化，请基于当前作品重新执行 / A read node changed during generation; rerun from the current manuscript.');
    }
    for (const expected of preconditions?.worldbook ?? []) {
      if (canonical(project.worldbook.entries.find((item) => item.id === expected.id) ?? null) !== canonical(expected)) throw new Error('已读取的世界书在生成期间发生变化 / A read worldbook entry changed during generation.');
    }
    if (preconditions?.edges && canonical(project.edges.map(({ id, sourceNodeId, targetNodeId, semantic }) => ({ id, sourceNodeId, targetNodeId, semantic }))) !== canonical(preconditions.edges)) throw new Error('节点关系在生成期间发生变化 / Relationships changed during generation.');
    let result = drafts.reduce((current, draft) => acceptVersion(current, ownerId, draft.id), pending);
    result = mutations.reduce((current, change) => mutate(current, change), result);
    validateGraph(result);
    return updateWorkbench(result, ownerId, (work) => ({ ...work, mutations: mutations.map((change) => ({ ...change, status: 'accepted' })) }));
  } catch (error) {
    const conflict = error instanceof Error ? error.message : String(error);
    return updateWorkbench(pending, ownerId, (work) => ({ ...work, versions: work.versions.map((v) => ({ ...v, status: 'pending', conflict })),
      mutations: mutations.map((change) => ({ ...change, status: 'pending', conflict })) }));
  }
}

export function rollbackAgentTransaction(project: ProjectFile, ownerId: string): ProjectFile {
  const work = project.workbench?.[ownerId];
  const mutations = work?.mutations?.filter((m) => m.status === 'accepted') ?? [];
  const versions = work?.versions.filter((v) => v.status === 'accepted') ?? [];
  if (!mutations.length && !versions.length) throw new Error('No changes to roll back.');
  let result = [...mutations].reverse().reduce((current, change) => mutate(current, change, true), project);
  result = [...versions].reverse().reduce((current, version) => rollbackVersion(current, ownerId, version.id), result);
  validateGraph(result);
  return updateWorkbench(result, ownerId, (state) => ({ ...state,
    mutations: state.mutations?.map((m) => m.status === 'accepted' ? { ...m, status: 'rolled_back' } : m) }));
}
