import { createNode, nowIso } from './project';
import type { DraftVersion, NodeWorkbench, ProjectFile } from './types';

export const emptyWorkbench = (): NodeWorkbench => ({ messages: [], versions: [], activeVersionId: null });
export const CHAT_WORKBENCH = '__chat__';
export const isConversationId = (id: string) => id === CHAT_WORKBENCH || id.startsWith(`${CHAT_WORKBENCH}:`);
const stableSnapshot = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

export function updateWorkbench(project: ProjectFile, nodeId: string, updater: (current: NodeWorkbench) => NodeWorkbench): ProjectFile {
  if (!isConversationId(nodeId) && !project.nodes.some((node) => node.id === nodeId)) return project;
  return { ...project, workbench: { ...project.workbench, [nodeId]: updater(project.workbench?.[nodeId] ?? emptyWorkbench()) } };
}

export function addVersion(project: ProjectFile, nodeId: string, version: DraftVersion): ProjectFile {
  return updateWorkbench(project, nodeId, (state) => ({ ...state, versions: isConversationId(nodeId) ? [version] : [...state.versions, version], activeVersionId: version.id }));
}

export function acceptVersion(project: ProjectFile, nodeId: string, versionId: string): ProjectFile {
  const version = project.workbench?.[nodeId]?.versions.find((item) => item.id === versionId);
  const targetId = version?.targetNodeId ?? nodeId;
  const target = project.nodes.find((node) => node.id === targetId);
  if (!version || version.status !== 'pending' || (!target && (version.operation !== 'create' || targetId))) throw new Error('候选已处理或目标已删除 / Candidate unavailable.');
  if (version.operation === 'replace' && target!.type !== version.nodeType) throw new Error('节点类型已改变，请重新修改 / Node type changed.');
  if (version.operation === 'replace' && (target!.body ?? '') !== version.baseBody) {
    throw new Error('正文已在候选生成后改变。请以当前正文重新修改，避免覆盖你的编辑。 / Text changed; revise from current text.');
  }
  if (version.operation === 'replace' && version.baseTitle != null && target!.title !== version.baseTitle) throw new Error('标题已改变 / Title changed.');
  let result = project;
  let appliedNode = target;
  if (version.operation === 'create') {
    if (version.proposedNodeId && project.nodes.some((node) => node.id === version.proposedNodeId)) throw new Error('新节点 ID 已存在 / Created node ID already exists.');
    const sources = version.creationSourceNodeIds ?? (targetId ? [targetId] : []);
    if (sources.some((id) => !project.nodes.some((node) => node.id === id))) throw new Error('参考节点已删除 / Creation reference no longer exists.');
    const node = createNode(version.nodeType, project.nodes.length, { x: target ? target.position.x + target.size.width + 100 : 0, y: (target?.position.y ?? 0) + project.workbench![nodeId].versions.indexOf(version) * 300 });
    appliedNode = { ...node, id: version.proposedNodeId ?? node.id, title: version.title, body: version.body, metadata: { ...node.metadata, sourceNodeIds: sources, tags: ['ai', 'design'] } };
    result = { ...project, nodes: [...project.nodes, appliedNode] };
  } else {
    result = { ...project, nodes: project.nodes.map((node) => node.id === targetId ? { ...node, body: version.body, ...(version.baseTitle != null ? { title: version.title } : {}), metadata: { ...node.metadata, updatedAt: nowIso() } } : node) };
  }
  return updateWorkbench(result, nodeId, (state) => ({ ...state, versions: state.versions.map((item) => item.id === versionId ? { ...item, status: 'accepted', conflict: '', appliedNodeId: appliedNode!.id, appliedNodeSnapshot: version.operation === 'create' ? JSON.stringify(appliedNode) : null } : item) }));
}

/** A rollback touches only the affected body. New nodes can be removed only while untouched and unlinked. */
export function rollbackVersion(project: ProjectFile, ownerId: string, versionId: string): ProjectFile {
  const version = project.workbench?.[ownerId]?.versions.find((item) => item.id === versionId);
  if (!version || version.status !== 'accepted') throw new Error('此修改不能回滚 / This change cannot be rolled back.');
  const targetId = version.appliedNodeId ?? version.targetNodeId ?? ownerId;
  const node = project.nodes.find((item) => item.id === targetId);
  if (!node || (node.body ?? '') !== version.body) throw new Error('节点已有后续修改，请先查看对比，避免覆盖新内容 / Newer edits prevent rollback.');
  if (version.baseTitle != null && node.title !== version.title) throw new Error('标题有后续修改 / Newer title prevents rollback.');
  let next: ProjectFile;
  if (version.operation === 'create') {
    const referenced = project.edges.some((edge) => edge.sourceNodeId === targetId || edge.targetNodeId === targetId)
      || project.nodes.some((item) => item.id !== targetId && (item.metadata.sourceNodeIds.includes(targetId) || item.childNodeIds?.includes(targetId)));
    if (!version.appliedNodeSnapshot || stableSnapshot(node) !== stableSnapshot(JSON.parse(version.appliedNodeSnapshot)) || referenced) throw new Error('新节点已被编辑或关联，不能直接移除 / Created node was edited or linked.');
    next = { ...project, nodes: project.nodes.filter((item) => item.id !== targetId) };
  } else {
    next = { ...project, nodes: project.nodes.map((item) => item.id === targetId ? { ...item, body: version.baseBody, ...(version.baseTitle != null ? { title: version.baseTitle } : {}), metadata: { ...item.metadata, updatedAt: nowIso() } } : item) };
  }
  return updateWorkbench(next, ownerId, (state) => ({ ...state, versions: state.versions.map((item) => item.id === versionId ? { ...item, status: 'rolled_back' } : item) }));
}

/** Retain a conflicting result for inspection instead of overwriting edits made during the request. */
export function applyAgentVersions(project: ProjectFile, versions: DraftVersion[], authorizedTargets?: string[], ownerId = CHAT_WORKBENCH): ProjectFile {
  const base = versions.length ? updateWorkbench(project, ownerId, (state) => ({ ...state, versions: [], mutations: [], agentPreconditions: null, activeVersionId: null })) : project;
  return versions.reduce((current, version) => {
    const pending = updateWorkbench(current, ownerId, (state) => ({ ...state, versions: [...state.versions, version], activeVersionId: version.id }));
    try {
      if (authorizedTargets && !authorizedTargets.includes(version.targetNodeId ?? '')) throw new Error('目标授权已撤销 / Target authorization was revoked.');
      return acceptVersion(pending, ownerId, version.id);
    }
    catch (error) { return updateWorkbench(pending, ownerId, (state) => ({ ...state, versions: state.versions.map((item) => item.id === version.id ? { ...item, conflict: error instanceof Error ? error.message : String(error) } : item) })); }
  }, base);
}

export function deleteConversation(project: ProjectFile, id: string): ProjectFile {
  if (!isConversationId(id)) throw new Error('Invalid conversation');
  const workbench = { ...project.workbench };
  delete workbench[id];
  const remaining = Object.keys(workbench).filter(isConversationId);
  return { ...project, workbench, activeChatId: project.activeChatId === id || !remaining.includes(project.activeChatId ?? '') ? remaining[0] ?? null : project.activeChatId };
}

/** All-or-nothing rollback of the latest batch, in reverse creation order. */
export function rollbackAgentBatch(project: ProjectFile, ownerId: string): ProjectFile {
  const versions = project.workbench?.[ownerId]?.versions.filter((item) => item.status === 'accepted') ?? [];
  if (!versions.length) throw new Error('没有可回滚的修改 / No applied changes to roll back.');
  return [...versions].reverse().reduce((current, version) => rollbackVersion(current, ownerId, version.id), project);
}
