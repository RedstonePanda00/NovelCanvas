import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { mergeExternalProject } from './projectSync';
import { api } from './api';
import { normalizeProject, nowIso } from './project';
import type { CanvasEdge, CanvasNode, ProjectFile } from './types';

export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

interface StoreState {
  loaded: ProjectFile | null;
  session: number;
  project: ProjectFile | null;
  selectedNodeId: string;
  selectedEdgeId: string;
  past: ProjectFile[];
  future: ProjectFile[];
}

interface ProjectStoreValue extends StoreState {
  selectedNode: CanvasNode | null;
  selectedEdge: CanvasEdge | null;
  saveStatus: SaveStatus;
  saveMessage: string;
  canUndo: boolean;
  canRedo: boolean;
  openProject: (project: ProjectFile) => void;
  updateProject: (updater: (project: ProjectFile) => ProjectFile, recordHistory?: boolean) => void;
  selectNode: (id: string) => void;
  selectEdge: (id: string) => void;
  undo: () => void;
  redo: () => void;
  saveNow: () => Promise<void>;
}

const ProjectStoreContext = createContext<ProjectStoreValue | null>(null);

const initialState: StoreState = { loaded: null, session: 0, project: null, selectedNodeId: '', selectedEdgeId: '', past: [], future: [] };

export function ProjectStoreProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState(initialState);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [saveMessage, setSaveMessage] = useState('');
  const stateRef = useRef(state);
  const revisionRef = useRef('');
  const lastSavedRef = useRef<ProjectFile | null>(null);
  const queuedProjectRef = useRef<ProjectFile | null>(null);
  const runningSaveRef = useRef<Promise<void> | null>(null);

  useLayoutEffect(() => { stateRef.current = state; }, [state]);
  // Publish the save baseline only when React commits a load. A concurrent local
  // edit can reject a focus refresh without advancing the writer's revision.
  useLayoutEffect(() => {
    if (!state.loaded) return;
    revisionRef.current = state.loaded.updatedAt;
    lastSavedRef.current = state.loaded;
    queuedProjectRef.current = null;
  }, [state.loaded]);

  const openProject = useCallback((project: ProjectFile) => {
    const normalized = normalizeProject(project);
    setState((current) => ({ loaded: normalized, session: current.session + 1, project: normalized, selectedNodeId: normalized.nodes[0]?.id ?? '', selectedEdgeId: '', past: [], future: [] }));
    setSaveStatus('saved');
    setSaveMessage('');
  }, []);

  const updateProject = useCallback((updater: (project: ProjectFile) => ProjectFile, recordHistory = true) => {
    setState((current) => {
      if (!current.project) return current;
      const updated = updater(current.project);
      if (updated === current.project) return current;
      const next = { ...updated, updatedAt: nowIso() };
      return {
        ...current,
        project: next,
        past: recordHistory ? [...current.past.slice(-99), current.project] : current.past,
        future: [],
      };
    });
  }, []);

  const selectNode = useCallback((id: string) => setState((current) => ({ ...current, selectedNodeId: id, selectedEdgeId: '' })), []);
  const selectEdge = useCallback((id: string) => setState((current) => ({ ...current, selectedEdgeId: id, selectedNodeId: '' })), []);

  const undo = useCallback(() => setState((current) => {
    if (!current.project || !current.past.length) return current;
    const previous = current.past[current.past.length - 1];
    return { ...current, project: { ...previous, updatedAt: nowIso() }, past: current.past.slice(0, -1), future: [current.project, ...current.future].slice(0, 100) };
  }), []);

  const redo = useCallback(() => setState((current) => {
    if (!current.project || !current.future.length) return current;
    const next = current.future[0];
    return { ...current, project: { ...next, updatedAt: nowIso() }, past: [...current.past, current.project].slice(-100), future: current.future.slice(1) };
  }), []);

  const flushQueue = useCallback((): Promise<void> => {
    if (runningSaveRef.current) return runningSaveRef.current;
    const run = async () => {
      while (queuedProjectRef.current) {
        const projectToSave = queuedProjectRef.current;
        queuedProjectRef.current = null;
        setSaveStatus('saving');
        setSaveMessage('');
        try {
          const saved = await api.saveProject(projectToSave, revisionRef.current);
          revisionRef.current = saved.updatedAt;
          lastSavedRef.current = projectToSave;
        } catch (error) {
          queuedProjectRef.current ??= projectToSave;
          setSaveStatus('error');
          setSaveMessage(error instanceof Error ? error.message : 'Save failed.');
          throw error;
        }
      }
      const current = stateRef.current.project;
      setSaveStatus(current && current !== lastSavedRef.current ? 'dirty' : 'saved');
    };
    runningSaveRef.current = run().finally(() => { runningSaveRef.current = null; });
    return runningSaveRef.current;
  }, []);

  const saveNow = useCallback(async () => {
    const current = stateRef.current.project;
    if (!current || (current === lastSavedRef.current && !runningSaveRef.current && !queuedProjectRef.current)) return;
    queuedProjectRef.current = current;
    await flushQueue();
  }, [flushQueue]);

  useEffect(() => {
    if (!state.project) return;
    if (state.project === lastSavedRef.current) return;
    setSaveStatus((status) => status === 'error' ? status : 'dirty');
    const timeout = window.setTimeout(() => {
      if (state.project === lastSavedRef.current) return;
      queuedProjectRef.current = state.project;
      void flushQueue().catch(() => undefined);
    }, 800);
    return () => window.clearTimeout(timeout);
  }, [flushQueue, state.project]);

  useEffect(() => {
    // Switching back from an external agent refreshes a clean canvas.
    let active = true;
    const refresh = async () => {
      const before = stateRef.current;
      const revision = revisionRef.current;
      if (!before.project || runningSaveRef.current || queuedProjectRef.current ||
          before.project !== lastSavedRef.current) return;
      try {
        const latest = await api.getProjectIfChanged(revision);
        if (!active || !latest || revision !== revisionRef.current || before !== stateRef.current ||
            runningSaveRef.current || queuedProjectRef.current || latest.updatedAt === revision) return;
        if (before.project.createdAt !== latest.createdAt) { openProject(latest); return; }
        const { project, rebase } = mergeExternalProject(before.project, normalizeProject(latest));
        const past: ProjectFile[] = [], future: ProjectFile[] = [];
        for (let i = before.past.length - 1; i >= 0; i--) {
          const snapshot = rebase(before.past[i]);
          if (!snapshot) break;
          past.unshift(snapshot);
        }
        for (const item of before.future) {
          const snapshot = rebase(item);
          if (!snapshot) break;
          future.push(snapshot);
        }
        setState(current => current.project !== before.project ? current : {
          ...current, loaded: project, project, past, future,
          selectedNodeId: project.nodes.some(n => n.id === current.selectedNodeId) ? current.selectedNodeId : '',
          selectedEdgeId: project.edges.some(e => e.id === current.selectedEdgeId) ? current.selectedEdgeId : '',
        });
      } catch { /* Keep the open draft if the backend is offline. */ }
    };
    window.addEventListener('focus', refresh);
    return () => { active = false; window.removeEventListener('focus', refresh); };
  }, [openProject]);

  const selectedNode = useMemo(
    () => state.project?.nodes.find((node) => node.id === state.selectedNodeId) ?? null,
    [state.project?.nodes, state.selectedNodeId],
  );
  const selectedEdge = useMemo(
    () => state.project?.edges.find((edge) => edge.id === state.selectedEdgeId) ?? null,
    [state.project?.edges, state.selectedEdgeId],
  );

  const value = useMemo<ProjectStoreValue>(() => ({
    ...state,
    selectedNode,
    selectedEdge,
    saveStatus,
    saveMessage,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    openProject,
    updateProject,
    selectNode,
    selectEdge,
    undo,
    redo,
    saveNow,
  }), [openProject, redo, saveMessage, saveNow, saveStatus, selectEdge, selectNode, selectedEdge, selectedNode, state, undo, updateProject]);

  return <ProjectStoreContext.Provider value={value}>{children}</ProjectStoreContext.Provider>;
}

export function useProjectStore() {
  const value = useContext(ProjectStoreContext);
  if (!value) throw new Error('useProjectStore must be used within ProjectStoreProvider');
  return value;
}
