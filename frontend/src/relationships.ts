import { createEdge } from './project';
import type { EdgeSemantic, ProjectFile } from './types';

export const relationshipLabels: Record<EdgeSemantic, [string, string, string, string]> = {
  reference: ['参考资料', 'Reference', '来源节点为目标提供背景资料。', 'Source supplies reference material to the target.'],
  must_follow: ['必须承接', 'Must follow', '目标必须承接来源的情节和约束。', 'Target follows the source events and constraints.'],
  instruction: ['写作指令', 'Instruction', '来源包含目标应执行的写作要求。', 'Source gives writing instructions for the target.'],
  can_rewrite: ['允许改写', 'May rewrite', '目标可改写来源内容。', 'Target may rewrite the source material.'],
  style_reference: ['风格参考', 'Style reference', '目标参考来源的文风。', 'Target uses the source as a style reference.'],
  review_basis: ['原审阅依据', 'Legacy review basis', '保留旧审阅资料的来源关系。', 'Preserved source relationship for migrated review notes.'],
  review_target: ['原审阅对象', 'Legacy review target', '保留旧审阅资料对应的被检查文本。', 'Preserved relationship to the text originally reviewed.'],
};

export function addRelationship(project: ProjectFile, sourceId: string, targetId: string, semantic: EdgeSemantic): ProjectFile {
  if (sourceId === targetId || ![sourceId, targetId].every((id) => project.nodes.some((node) => node.id === id))) throw new Error('请选择两个不同的现有节点 / Select two existing nodes.');
  if (project.edges.some((edge) => edge.sourceNodeId === sourceId && edge.targetNodeId === targetId && edge.semantic === semantic)) return project;
  return { ...project, edges: [...project.edges, createEdge(sourceId, targetId, semantic)] };
}
