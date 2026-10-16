type Snapshot = Record<string, unknown>;
type Workspace = Record<string, Record<string, unknown>>;

/** Reassemble transport deltas before persisting a self-contained resume point. */
export function mergeAgentCheckpoint(previous: Snapshot | null | undefined, update: Snapshot): Snapshot {
  if (!update.workspaceDelta) return update;
  if (!previous?.workspace || previous.step !== update.baseStep) throw new Error('Checkpoint sequence interrupted; resume from the previous step.');
  const old = previous.workspace as Snapshot;
  const workspace: Workspace = { ...old,
    nodes: Object.fromEntries((old.nodes as Array<{ id: string }>).map((node) => [node.id, node])),
    reads: Object.fromEntries((old.reads as unknown[][]).map((read) => [read[0] as string, read])),
  } as Workspace;
  for (const [field, changes] of Object.entries(update.workspaceDelta as Workspace)) {
    workspace[field] = { ...workspace[field] };
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) delete workspace[field][key];
      else workspace[field][key] = value;
    }
  }
  const { workspaceDelta: _delta, baseStep: _base, ...rest } = update;
  return { ...rest, workspace: { ...workspace, nodes: Object.values(workspace.nodes), reads: Object.values(workspace.reads) } };
}
