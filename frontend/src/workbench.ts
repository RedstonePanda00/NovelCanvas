import { createNode, nowIso } from './project';
import type { DraftVersion, NodeWorkbench, ProjectFile } from './types';

export const emptyWorkbench = (): NodeWorkbench => ({ messages: [], versions: [], activeVersionId: null });
export function updateWorkbench(project: ProjectFile, nodeId: string, updater: (current: NodeWorkbench) => NodeWorkbench): ProjectFile {
  if (!project.nodes.some((node) => node.id === nodeId)) return project;
  return { ...project, workbench: { ...project.workbench, [nodeId]: updater(project.workbench?.[nodeId] ?? emptyWorkbench()) } };
}

export function addVersion(project: ProjectFile, nodeId: string, version: DraftVersion): ProjectFile {
  return updateWorkbench(project, nodeId, (state) => ({ ...state, versions: [...state.versions, version], activeVersionId: version.id }));
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
