import { describe, expect, it } from 'vitest';
import { createEmptyProject, createNode } from '../src/project';
import { acceptVersion, addVersion } from '../src/workbench';
import { addRelationship } from '../src/relationships';
import type { DraftVersion } from '../src/types';

const target = createNode('paragraph', 0, { x: 0, y: 0 }); target.body = 'Original';
const draft: DraftVersion = { id: 'v1', title: 'Candidate', body: 'Revision', baseBody: 'Original', feedback: 'Shorten', preserve: 'Ending', rationale: 'Reason stays in discussion', nodeType: 'paragraph', operation: 'replace', status: 'pending', createdAt: 'now' };
const project = { ...createEmptyProject(), nodes: [target] };

describe('version acceptance', () => {
  it('keeps original content untouched until acceptance and retains lineage', () => {
    const pending = addVersion(project, target.id, draft);
    expect(pending.nodes[0].body).toBe('Original');
    const second = addVersion(pending, target.id, { ...draft, id: 'v2', parentId: 'v1', body: 'Better revision' });
    const accepted = acceptVersion(second, target.id, 'v2');
    expect(accepted.nodes[0].body).toBe('Better revision');
    expect(accepted.workbench![target.id].versions).toHaveLength(2);
    expect(accepted.workbench![target.id].versions[1].parentId).toBe('v1');
    expect(() => acceptVersion(accepted, target.id, 'v2')).toThrow();
  });
  it('rejects stale and deleted-target candidates', () => {
    const pending = addVersion(project, target.id, draft);
    expect(() => acceptVersion({ ...pending, nodes: [{ ...target, body: 'Manual edit' }] }, target.id, 'v1')).toThrow(/changed/);
    expect(() => acceptVersion({ ...pending, nodes: [] }, target.id, 'v1')).toThrow();
  });
  it('creates a node without leaking the rationale or changing its reference target', () => {
    const pending = addVersion(project, target.id, { ...draft, nodeType: 'character', operation: 'create' });
    const accepted = acceptVersion(pending, target.id, 'v1');
    expect(accepted.nodes).toHaveLength(2);
    expect(accepted.nodes[0].body).toBe('Original');
    expect(accepted.nodes[1]).toMatchObject({ type: 'character', title: 'Candidate', body: 'Revision' });
    expect(accepted.nodes[1].body).not.toContain('Reason');
  });
});

describe('relationship commands', () => {
  it('adds directed references once while allowing different semantics', () => {
    const other = createNode('scene', 1, { x: 500, y: 0 });
    const linked = addRelationship({ ...project, nodes: [target, other] }, other.id, target.id, 'reference');
    expect(linked.edges[0]).toMatchObject({ sourceNodeId: other.id, targetNodeId: target.id, semantic: 'reference' });
    expect(addRelationship(linked, other.id, target.id, 'reference')).toBe(linked);
    expect(addRelationship(linked, other.id, target.id, 'must_follow').edges).toHaveLength(2);
    expect(() => addRelationship(linked, target.id, target.id, 'reference')).toThrow();
  });
});
