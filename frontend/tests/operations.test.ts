import { describe, expect, it } from 'vitest';
import { applyGenerationPlan, parseWorldbookImport } from '../src/projectOperations';
import { createEmptyProject, createNode, createEdge } from '../src/project';
import type { AIGenerationPlan } from '../src/types';

describe('project operations', () => {
  it('replaces chapter children in place and migrates incoming and outgoing edges', () => {
    const [chapter, before, source, after, first, last] = ['container', 'scene', 'scene', 'scene', 'scene', 'scene'].map((type, index) => createNode(type as 'scene' | 'container', index, { x: 0, y: 0 }));
    chapter.childNodeIds = [before.id, source.id, after.id];
    const project = { ...createEmptyProject(), nodes: [chapter, before, source, after], edges: [createEdge(before.id, source.id), createEdge(source.id, after.id)] };
    const plan = { workflow: 'split-scene', replacedNodeIds: [source.id], plannedNodes: [first, last], plannedEdges: [createEdge(first.id, last.id)] } as AIGenerationPlan;
    const result = applyGenerationPlan(project, plan);
    expect(result.nodes[0].childNodeIds).toEqual([before.id, first.id, last.id, after.id]);
    expect(result.nodes.some((node) => node.id === source.id)).toBe(false);
    expect(result.edges[0].targetNodeId).toBe(first.id);
    expect(result.edges[1].sourceNodeId).toBe(last.id);
    expect(() => applyGenerationPlan(result, plan)).toThrow();
  });

  it.each([{ keys: null }, { tags: 'bad' }, { enabled: 'yes' }, { tokenBudget: -1 }, { priority: 1.5 }, { insertionPosition: 'bad' }, null])('rejects malformed lore without changing project state: %j', (entry) => {
    expect(() => parseWorldbookImport({ entries: [entry] })).toThrow();
  });
  it('normalizes valid legacy entries and rejects duplicate IDs', () => {
    expect(parseWorldbookImport([{ title: 'Lore' }])[0]).toMatchObject({ title: 'Lore', keys: [], tags: [], enabled: true });
    expect(() => parseWorldbookImport([{ id: 'same' }, { id: 'same' }])).toThrow();
  });
});
