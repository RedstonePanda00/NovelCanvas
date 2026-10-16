import { describe, expect, it } from 'vitest';
import { mergeAgentCheckpoint } from '../src/agentCheckpoint';

describe('durable agent checkpoints', () => {
  it('merges deltas into a standalone checkpoint without changing the previous checkpoint', () => {
    const initial = { version: 1, step: 1, workspace: { nodes: [{ id: 'a', body: 'old' }], reads: [['a', 'old-token', [[0, 3]]]], created: {}, verified: { a: 'old-token' }, searches: {}, searchPages: {} } };
    const next = mergeAgentCheckpoint(initial, { version: 1, step: 2, baseStep: 1, memory: 'Continue', workspaceDelta: { nodes: { a: { id: 'a', body: 'new' }, b: { id: 'b', body: 'created' } }, reads: { a: null }, verified: { a: null }, created: { b: 'a' }, workItems: { a: { status: 'pending' } } } });
    expect(next).toMatchObject({ step: 2, workspace: { nodes: [{ id: 'a', body: 'new' }, { id: 'b', body: 'created' }], reads: [], verified: {}, created: { b: 'a' }, workItems: { a: { status: 'pending' } } } });
    expect(next).not.toHaveProperty('workspaceDelta');
    expect(initial.workspace.nodes).toEqual([{ id: 'a', body: 'old' }]);
    const removed = mergeAgentCheckpoint(next, { version: 1, step: 3, baseStep: 2, workspaceDelta: { nodes: { b: null }, created: { b: null } } });
    expect((removed.workspace as { nodes: unknown[] }).nodes).toHaveLength(1);
    expect(() => mergeAgentCheckpoint(initial, { step: 4, baseStep: 3, workspaceDelta: {} })).toThrow(/interrupted/);
  });
});
