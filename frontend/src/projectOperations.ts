import { createWorldbookEntry } from './project';
import type { AIGenerationPlan, ProjectFile, WorldbookEntry } from './types';

export function applyGenerationPlan(project: ProjectFile, plan: AIGenerationPlan): ProjectFile {
  const existing = new Set(project.nodes.map((node) => node.id));
  if (plan.plannedNodes.some((node) => existing.has(node.id))) throw new Error('Generated node already exists.');
  const replaced = new Set(plan.workflow === 'split-scene' ? plan.replacedNodeIds ?? [] : []);
  if ([...replaced].some((id) => !existing.has(id))) throw new Error('The source scene was removed. Generate a new plan.');
  const first = plan.plannedNodes[0];
  const last = plan.plannedNodes[plan.plannedNodes.length - 1];
  if (replaced.size && (!first || !last)) throw new Error('The split plan has no scenes.');
  const replacementIds = plan.plannedNodes.map((node) => node.id);
  const nodes = [...project.nodes.filter((node) => !replaced.has(node.id)).map((node) => {
    if (!node.childNodeIds.some((id) => replaced.has(id))) return node;
    return { ...node, childNodeIds: [...new Set(node.childNodeIds.flatMap((id) => replaced.has(id) ? replacementIds : [id]))] };
  }), ...plan.plannedNodes];
  const edges = project.edges.flatMap((edge) => {
    const source = replaced.has(edge.sourceNodeId);
    const target = replaced.has(edge.targetNodeId);
    if (source && target) return [];
    return [{ ...edge, sourceNodeId: source ? last!.id : edge.sourceNodeId, targetNodeId: target ? first!.id : edge.targetNodeId }];
  });
  const valid = new Set(nodes.map((node) => node.id));
  if (plan.plannedEdges.some((edge) => !valid.has(edge.sourceNodeId) || !valid.has(edge.targetNodeId))) {
    throw new Error('A referenced node was removed. Generate a new plan.');
  }
  return { ...project, nodes, edges: [...edges, ...plan.plannedEdges] };
}

export function parseWorldbookImport(payload: unknown): WorldbookEntry[] {
  const raw = Array.isArray(payload) ? payload : payload && typeof payload === 'object' ? (payload as Record<string, unknown>).entries : undefined;
  if (!Array.isArray(raw)) throw new Error('Invalid Worldbook JSON: expected an entries array.');
  const ids = new Set<string>();
  return raw.map((value, index) => {
    const fail = () => { throw new Error(`Invalid Worldbook entry ${index + 1}.`); };
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
    const entry = value as Record<string, unknown>;
    for (const key of ['id', 'title', 'content']) if (entry[key] !== undefined && typeof entry[key] !== 'string') fail();
    for (const key of ['keys', 'tags']) if (entry[key] !== undefined && (!Array.isArray(entry[key]) || !(entry[key] as unknown[]).every((item) => typeof item === 'string'))) fail();
    for (const key of ['enabled', 'alwaysOn']) if (entry[key] !== undefined && typeof entry[key] !== 'boolean') fail();
    if (entry.priority !== undefined && !Number.isInteger(entry.priority)) fail();
    if (entry.tokenBudget !== undefined && entry.tokenBudget !== null && (!Number.isInteger(entry.tokenBudget) || (entry.tokenBudget as number) < 0)) fail();
    if (entry.insertionPosition !== undefined && !['before_context', 'after_context'].includes(entry.insertionPosition as string)) fail();
    const defaults = createWorldbookEntry();
    const result = Object.fromEntries(Object.keys(defaults).map((key) => [key, entry[key] === undefined ? defaults[key as keyof WorldbookEntry] : entry[key]])) as unknown as WorldbookEntry;
    result.id ||= defaults.id;
    if (ids.has(result.id)) fail();
    ids.add(result.id);
    return result;
  });
}
