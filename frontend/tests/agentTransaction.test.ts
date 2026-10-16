import { describe, expect, it } from 'vitest';
import { applyAgentTransaction, rollbackAgentTransaction } from '../src/agentTransaction';
import { createEmptyProject, createNode, createEdge } from '../src/project';
import type { AgentMutation, DraftVersion } from '../src/types';

const owner = '__chat__:agent';
const baseChange = { status: 'pending' as const, createdAt: 'now', after: null };

describe('atomic manuscript transactions', () => {
  it('refuses to commit when an unchanged reference node has been edited during generation', () => {
    const target = { ...createNode('paragraph', 0), body: 'Original prose' };
    const reference = { ...createNode('character', 1), body: 'Original character facts' };
    const project = { ...createEmptyProject(), nodes: [target, { ...reference, body: 'New character facts' }] };
    const draft: DraftVersion = { id: 'v', targetNodeId: target.id, nodeType: 'paragraph', operation: 'replace', title: target.title, body: 'Prose based on old facts', baseBody: target.body, feedback: '', preserve: '', rationale: '', status: 'pending', createdAt: 'now' };
    const preconditions = { nodes: [{ id: reference.id, type: reference.type, title: reference.title, body: reference.body,
      childNodeIds: [], sourceNodeIds: [], tags: [], narrativeTask: reference.narrativeTask, targetWordCount: reference.targetWordCount, outlineLevel: reference.outlineLevel }], worldbook: [] };
    const result = applyAgentTransaction(project, [draft], [], owner, preconditions);
    expect(result.nodes[0].body).toBe('Original prose');
    expect(result.nodes[1].body).toBe('New character facts');
    expect(result.workbench?.[owner].versions[0].conflict).toMatch(/read node changed/);
    expect(result.workbench?.[owner].agentPreconditions).toEqual(preconditions);
  });
  it('commits text and canon together, rolls both back, and preserves the entire original when canon conflicts', () => {
    const node = { ...createNode('paragraph', 0), body: 'Blue eyes' };
    const lore = { id: 'lore', title: 'Eyes', content: 'Blue', keys: [], tags: [], enabled: true, alwaysOn: false, priority: 0, insertionPosition: 'after_context' as const };
    const project = { ...createEmptyProject(), nodes: [node], worldbook: { entries: [lore] } };
    const draft: DraftVersion = { id: 'v', targetNodeId: node.id, nodeType: 'paragraph', operation: 'replace', title: node.title, body: 'Green eyes', baseBody: 'Blue eyes', feedback: 'Change the canon', preserve: '', rationale: '', status: 'pending', createdAt: 'now' };
    const change: AgentMutation = { ...baseChange, id: 'm', kind: 'worldbook', targetId: 'lore', before: lore, after: { ...lore, content: 'Green' } };
    const applied = applyAgentTransaction(project, [draft], [change], owner);
    expect(applied.nodes[0].body).toBe('Green eyes');
    expect(applied.worldbook.entries[0].content).toBe('Green');
    const rolled = rollbackAgentTransaction(applied, owner);
    expect(rolled.nodes[0].body).toBe('Blue eyes');
    expect(rolled.worldbook.entries[0].content).toBe('Blue');
    const manual = { ...project, worldbook: { entries: [{ ...lore, content: 'Author changed this fact' }] } };
    const conflict = applyAgentTransaction(manual, [draft], [change], owner);
    expect(conflict.nodes[0].body).toBe('Blue eyes');
    expect(conflict.worldbook.entries[0].content).toBe('Author changed this fact');
    expect(conflict.workbench?.[owner].versions[0].status).toBe('pending');
    expect(conflict.workbench?.[owner].mutations?.[0].status).toBe('pending');
    expect(() => rollbackAgentTransaction({ ...applied, worldbook: manual.worldbook }, owner)).toThrow(/changed/);
  });
  it('deletes adjacent nodes and incident edges, then restores their original order', () => {
    const nodes = [0, 1, 2].map((i) => createNode('paragraph', i));
    const edge = createEdge(nodes[0].id, nodes[2].id, 'reference');
    const project = { ...createEmptyProject(), nodes, edges: [edge] };
    const changes: AgentMutation[] = [
      { ...baseChange, id: 'd1', kind: 'node_delete', targetId: nodes[1].id, before: nodes[1] as unknown as Record<string, unknown>, index: 1 },
      { ...baseChange, id: 'e', kind: 'edge', targetId: edge.id, before: edge as unknown as Record<string, unknown>, index: 0 },
      { ...baseChange, id: 'd0', kind: 'node_delete', targetId: nodes[0].id, before: nodes[0] as unknown as Record<string, unknown>, index: 0 },
    ];
    const applied = applyAgentTransaction(project, [], changes, owner);
    expect(applied.nodes.map((n) => n.id)).toEqual([nodes[2].id]);
    expect(applied.edges).toHaveLength(0);
    const rolled = rollbackAgentTransaction(applied, owner);
    expect(rolled.nodes).toEqual(nodes);
    expect(rolled.edges).toEqual([edge]);
    expect(rolled.workbench?.[owner].mutations?.every((m) => m.status === 'rolled_back')).toBe(true);
  });
});
