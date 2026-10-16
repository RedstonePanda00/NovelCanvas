const labels: Record<string, [string, string]> = {
  delegate_parallel: ['并行子代理', 'Parallel agents'],
  search_nodes: ['搜索作品', 'Search manuscript'], read_node: ['读取节点', 'Read node'],
  patch_node: ['修改正文', 'Patch text'], create_node: ['创建节点', 'Create node'],
  rename_node: ['修改标题', 'Rename node'], list_changes: ['检查改动', 'Inspect changes'],
  search_worldbook: ['搜索世界书', 'Search worldbook'], read_worldbook: ['读取世界书', 'Read worldbook'],
  plan_work: ['建立任务清单', 'Plan targets'], work_status: ['检查任务进度', 'Check progress'],
  complete_target: ['完成节点检查', 'Complete target review'], list_relationships: ['读取关系', 'Read relationships'],
  matching_worldbook: ['查找相关设定', 'Find relevant lore'], set_relationship: ['调整关系', 'Update relationship'],
  delete_node: ['删除节点', 'Delete node'], patch_worldbook: ['修改世界书事实', 'Update worldbook facts'],
  create_worldbook: ['新增世界书条目', 'Create worldbook entry'],
};
export const agentToolLabel = (tool: string, zh: boolean) => labels[tool]?.[zh ? 0 : 1] ?? tool;
export const agentActivityKey = (item: AgentActivity) => item.tool === 'delegate_parallel'
  ? `${item.step}:${item.title ?? ''}:${item.message ?? ''}` : String(item.step);
import type { AgentActivity } from './types';
