import type { AssistantResponse, DraftVersion, ProjectFile } from './types';

/** Bind model results to the exact manuscript snapshot used for this request. */
export function agentDrafts(project: ProjectFile, response: AssistantResponse, scope: 'attached' | 'project',
  targets: string[], instruction: string, timestamp: string): DraftVersion[] {
  const known = new Set(project.nodes.map((node) => node.id));
  return (response.edits ?? []).map((edit) => {
    if (scope === 'attached' && !targets.includes(edit.targetNodeId)) throw new Error('Unauthorized target.');
    const original = project.nodes.find((node) => node.id === edit.targetNodeId);
    if (edit.operation === 'replace' && !original) throw new Error('Unknown replacement target.');
    if (edit.operation === 'create' && edit.targetNodeId && !known.has(edit.targetNodeId)) throw new Error('Unknown creation anchor.');
    if (scope === 'project' && edit.operation === 'replace' && edit.baseBody !== undefined && edit.baseBody !== (original?.body ?? '')) throw new Error('Agent result has a stale base version.');
    if (edit.proposedNodeId) {
      if (known.has(edit.proposedNodeId)) throw new Error('Duplicate created node ID.');
      known.add(edit.proposedNodeId);
    }
    return { ...edit, id: crypto.randomUUID(), baseBody: edit.operation === 'create' ? '' : original?.body ?? '',
      feedback: instruction, preserve: '', rationale: response.reply, status: 'pending', createdAt: timestamp,
      referenceNodeIds: response.context.nodes.map((node) => node.id),
      worldbookEntryIds: response.context.worldbook.map((entry) => entry.id) };
  });
}
