import type { CanvasNode, ProjectFile } from './types';

// Network snapshots have fresh object identities and may have a different key order.
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key =>
    Object.prototype.hasOwnProperty.call(right, key) && equal(left[key], right[key]));
}

export function mergeExternalProject(base: ProjectFile, latest: ProjectFile) {
  const previous = new Map(base.nodes.map(node => [node.id, node]));
  const changed = new Map<string, { fields: Partial<CanvasNode>; updatedAt: string }>();
  const sameEdges = equal(base.edges, latest.edges);
  let textOnly = base.nodes.length === latest.nodes.length && sameEdges &&
    equal(base.workbench, latest.workbench) && equal(base.settings, latest.settings) &&
    equal(base.worldbook, latest.worldbook) && base.activeChatId === latest.activeChatId && base.version === latest.version;
  const nodes = latest.nodes.map((node, index) => {
    const old = previous.get(node.id);
    if (base.nodes[index]?.id !== node.id) textOnly = false;
    if (!old) return node;
    if (equal(old, node)) return old;
    const patch: Partial<CanvasNode> = {};
    if (old.title !== node.title) patch.title = node.title;
    if (old.body !== node.body) patch.body = node.body;
    const metadata = { ...old.metadata, updatedAt: node.metadata.updatedAt };
    if (!equal({ ...old, ...patch, metadata }, node)) textOnly = false;
    changed.set(node.id, { fields: patch, updatedAt: node.metadata.updatedAt });
    return node;
  });
  const project = { ...latest, nodes, edges: sameEdges ? base.edges : latest.edges };

  // Snapshots before a structural change can refer to deleted nodes or old edges.
  // For text edits carry the external fields into each reachable undo/redo state.
  function rebase(snapshot: ProjectFile): ProjectFile | null {
    if (!textOnly) return null;
    let found = 0;
    const rebased = changed.size ? snapshot.nodes.map(node => {
      const patch = changed.get(node.id);
      if (!patch) return node;
      found++;
      return { ...node, ...patch.fields, metadata: { ...node.metadata, updatedAt: patch.updatedAt } };
    }) : snapshot.nodes;
    if (found !== changed.size) return null;
    return { ...snapshot, nodes: rebased, title: base.title === latest.title ? snapshot.title : latest.title };
  }
  return { project, rebase };
}
