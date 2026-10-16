import { describe, expect, it } from 'vitest';
import { agentDrafts } from '../src/agentConversation';
import { createEmptyProject, createNode } from '../src/project';
import type { AssistantResponse } from '../src/types';

describe('project agent result binding', () => {
  it('permits located targets outside attachments but rejects unknown replacements and stale snapshots', () => {
    const node = { ...createNode('paragraph', 0), body: 'Original' };
    const project = { ...createEmptyProject(), nodes: [node] };
    const response: AssistantResponse = { reply: 'Done', context: { nodes: [], worldbook: [] }, edits: [{ targetNodeId: node.id, nodeType: 'paragraph', operation: 'replace', title: node.title, body: 'Updated', baseBody: 'Original' }] };
    expect(agentDrafts(project, response, 'project', [], 'Revise across the novel', 'now')[0].baseBody).toBe('Original');
    expect(() => agentDrafts(project, response, 'attached', [], 'Revise', 'now')).toThrow(/Unauthorized/);
    expect(() => agentDrafts(createEmptyProject(), response, 'project', [], 'Revise', 'now')).toThrow(/Unknown/);
    response.edits![0].baseBody = 'Stale';
    expect(() => agentDrafts(project, response, 'project', [], 'Revise', 'now')).toThrow(/stale/);
  });
  it('accepts creation dependencies in order and rejects duplicate or invented IDs', () => {
    const response: AssistantResponse = { reply: 'Done', context: { nodes: [], worldbook: [] }, edits: [
      { targetNodeId: '', proposedNodeId: 'first', nodeType: 'character', operation: 'create', title: 'Mira', body: 'Navigator' },
      { targetNodeId: 'first', proposedNodeId: 'second', nodeType: 'scene', operation: 'create', title: 'Departure', body: 'A crossing' },
    ] };
    expect(agentDrafts(createEmptyProject(), response, 'project', [], 'Design', 'now')).toHaveLength(2);
    response.edits![1].proposedNodeId = 'first';
    expect(() => agentDrafts(createEmptyProject(), response, 'project', [], 'Design', 'now')).toThrow(/Duplicate/);
  });
});
