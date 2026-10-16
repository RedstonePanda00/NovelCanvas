import { describe, expect, it } from 'vitest';
import { createEmptyProject, createNode } from '../src/project';
import { acceptVersion, addVersion, applyAgentVersions, CHAT_WORKBENCH, deleteConversation, rollbackVersion, rollbackAgentBatch, updateWorkbench } from '../src/workbench';
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

describe('direct agent edits and rollback', () => {
  it('creates a chain in an empty project with stable IDs and rolls back in dependency order', () => {
    const first: DraftVersion = { ...draft, targetNodeId: '', proposedNodeId: 'new-character', operation: 'create', nodeType: 'character', creationSourceNodeIds: [] };
    const second: DraftVersion = { ...draft, id: 'v2', targetNodeId: 'new-character', proposedNodeId: 'new-scene', operation: 'create', nodeType: 'scene', creationSourceNodeIds: ['new-character'] };
    const applied = applyAgentVersions(createEmptyProject(), [first, second]);
    expect(applied.nodes.map((node) => node.id)).toEqual(['new-character', 'new-scene']);
    expect(applied.nodes[1].metadata.sourceNodeIds).toEqual(['new-character']);
    expect(rollbackAgentBatch(applied, CHAT_WORKBENCH).nodes).toHaveLength(0);
    expect(() => rollbackVersion(applied, CHAT_WORKBENCH, first.id)).toThrow(/linked/);
    const rolled = rollbackVersion(rollbackVersion(applied, CHAT_WORKBENCH, second.id), CHAT_WORKBENCH, first.id);
    expect(rolled.nodes).toHaveLength(0);
  });
  it('renames only when explicitly requested and protects newer title edits on apply and rollback', () => {
    const renamed = { ...draft, targetNodeId: target.id, baseTitle: target.title, title: 'New title' };
    const applied = applyAgentVersions(project, [renamed]);
    expect(applied.nodes[0].title).toBe('New title');
    expect(rollbackVersion(applied, CHAT_WORKBENCH, draft.id).nodes[0].title).toBe(target.title);
    const manual = { ...project, nodes: [{ ...target, title: 'Author title' }] };
    expect(applyAgentVersions(manual, [renamed]).workbench?.[CHAT_WORKBENCH].versions[0].conflict).toMatch(/Title changed/);
    expect(() => rollbackVersion({ ...applied, nodes: [{ ...applied.nodes[0], title: 'Author title' }] }, CHAT_WORKBENCH, draft.id)).toThrow(/Newer title/);
    expect(() => rollbackAgentBatch({ ...applied, nodes: [{ ...applied.nodes[0], title: 'Author title' }] }, CHAT_WORKBENCH)).toThrow(/Newer title/);
  });
  it('deletes the conversation and its history without undoing its manuscript changes', () => {
    const owner = '__chat__:delete';
    let applied = applyAgentVersions(project, [{ ...draft, targetNodeId: target.id }], [target.id], owner);
    applied = updateWorkbench(applied, '__chat__:keep', (state) => ({ ...state, draft: 'Keep me' }));
    const result = deleteConversation({ ...applied, activeChatId: owner }, owner);
    expect(result.nodes[0].body).toBe('Revision');
    expect(result.workbench?.[owner]).toBeUndefined();
    expect(result.activeChatId).toBe('__chat__:keep');
    expect(result.workbench?.['__chat__:keep'].draft).toBe('Keep me');
    expect(result.workbench?.[target.id]).toBeUndefined();
  });
  it('keeps only the most recent edit batch within each conversation', () => {
    const first = applyAgentVersions(project, [{ ...draft, targetNodeId: target.id }]);
    const second = applyAgentVersions(first, [{ ...draft, id: 'v2', targetNodeId: target.id, baseBody: 'Revision', body: 'Latest' }]);
    expect(second.workbench?.[CHAT_WORKBENCH].versions.map((version) => version.id)).toEqual(['v2']);
    expect(rollbackVersion(second, CHAT_WORKBENCH, 'v2').nodes[0].body).toBe('Revision');
  });
  it('stores changes under the originating conversation', () => {
    const owner = '__chat__:second';
    const applied = applyAgentVersions(project, [{ ...draft, targetNodeId: target.id }], [target.id], owner);
    expect(applied.workbench?.[CHAT_WORKBENCH]).toBeUndefined();
    expect(applied.workbench?.[owner].versions).toHaveLength(1);
    expect(rollbackVersion(applied, owner, draft.id).nodes[0].body).toBe('Original');
  });
  it('retains originals, applies edits, and rolls back without overwriting unrelated metadata', () => {
    const applied = applyAgentVersions(project, [{ ...draft, targetNodeId: target.id }]);
    expect(applied.nodes[0].body).toBe('Revision');
    expect(applied.workbench![CHAT_WORKBENCH].versions[0].status).toBe('accepted');
    const moved = { ...applied, nodes: applied.nodes.map((node) => ({ ...node, position: { x: 99, y: 20 }, title: 'Renamed' })) };
    const rolled = rollbackVersion(moved, CHAT_WORKBENCH, draft.id);
    expect(rolled.nodes[0]).toMatchObject({ body: 'Original', title: 'Renamed', position: { x: 99, y: 20 } });
    expect(rolled.workbench![CHAT_WORKBENCH].versions[0].status).toBe('rolled_back');
    expect(() => rollbackVersion(rolled, CHAT_WORKBENCH, draft.id)).toThrow();
  });
  it('preserves concurrent manual edits and records conflicts for review', () => {
    const changed = { ...project, nodes: [{ ...target, body: 'Manual edit' }] };
    const result = applyAgentVersions(changed, [{ ...draft, targetNodeId: target.id }]);
    expect(result.nodes[0].body).toBe('Manual edit');
    expect(result.workbench![CHAT_WORKBENCH].versions[0]).toMatchObject({ status: 'pending', body: 'Revision' });
    expect(result.workbench![CHAT_WORKBENCH].versions[0].conflict).toMatch(/changed/);
    const applied = applyAgentVersions(project, [{ ...draft, targetNodeId: target.id }]);
    expect(() => rollbackVersion({ ...applied, nodes: changed.nodes }, CHAT_WORKBENCH, draft.id)).toThrow(/Newer edits/);
    const revoked = applyAgentVersions(project, [{ ...draft, targetNodeId: target.id }], []);
    expect(revoked.nodes[0].body).toBe('Original');
    expect(revoked.workbench![CHAT_WORKBENCH].versions[0].conflict).toMatch(/revoked/);
  });
  it('removes an untouched created node but refuses to remove a linked or edited node', () => {
    const applied = applyAgentVersions(project, [{ ...draft, targetNodeId: target.id, operation: 'create', nodeType: 'character' }]);
    const created = applied.nodes[1];
    expect(rollbackVersion(applied, CHAT_WORKBENCH, draft.id).nodes).toHaveLength(1);
    const reordered = { ...applied, nodes: [applied.nodes[0], Object.fromEntries(Object.entries(created).reverse()) as typeof created] };
    expect(rollbackVersion(reordered, CHAT_WORKBENCH, draft.id).nodes).toHaveLength(1);
    const linked = addRelationship(applied, created.id, target.id, 'reference');
    expect(() => rollbackVersion(linked, CHAT_WORKBENCH, draft.id)).toThrow(/linked/);
    const moved = { ...applied, nodes: applied.nodes.map((node) => node.id === created.id ? { ...node, title: 'Edited name' } : node) };
    expect(() => rollbackVersion(moved, CHAT_WORKBENCH, draft.id)).toThrow(/edited/);
  });
});
