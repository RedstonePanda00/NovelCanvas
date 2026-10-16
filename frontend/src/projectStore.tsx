import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { normalizeProject, nowIso } from './project';
import type { CanvasEdge, CanvasNode, ProjectFile } from './types';

export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

interface StoreState {
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

const initialState: StoreState = { session: 0, project: null, selectedNodeId: '', selectedEdgeId: '', past: [], future: [] };

export function ProjectStoreProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState(initialState);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [saveMessage, setSaveMessage] = useState('');
  const stateRef = useRef(state);
  const lastSavedJsonRef = useRef('');
  const queuedProjectRef = useRef<ProjectFile | null>(null);
  const runningSaveRef = useRef<Promise<void> | null>(null);

  useEffect(() => { stateRef.current = state; }, [state]);

  const openProject = useCallback((project: ProjectFile) => {
    const normalized = normalizeProject(project);
    lastSavedJsonRef.current = JSON.stringify(normalized);
    queuedProjectRef.current = null;
    setState((current) => ({ session: current.session + 1, project: normalized, selectedNodeId: normalized.nodes[0]?.id ?? '', selectedEdgeId: '', past: [], future: [] }));
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
          await api.saveProject(projectToSave);
          lastSavedJsonRef.current = JSON.stringify(projectToSave);
        } catch (error) {
          queuedProjectRef.current = projectToSave;
          setSaveStatus('error');
          setSaveMessage(error instanceof Error ? error.message : 'Save failed.');
          throw error;
        }
      }
      const current = stateRef.current.project;
      setSaveStatus(current && JSON.stringify(current) !== lastSavedJsonRef.current ? 'dirty' : 'saved');
    };
    runningSaveRef.current = run().finally(() => { runningSaveRef.current = null; });
    return runningSaveRef.current;
  }, []);

  const saveNow = useCallback(async () => {
    const current = stateRef.current.project;
    if (!current) return;
    queuedProjectRef.current = current;
    await flushQueue();
  }, [flushQueue]);

  useEffect(() => {
    if (!state.project) return;
    const json = JSON.stringify(state.project);
    if (json === lastSavedJsonRef.current) return;
    setSaveStatus((status) => status === 'error' ? status : 'dirty');
    const timeout = window.setTimeout(() => {
      queuedProjectRef.current = state.project;
      void flushQueue().catch(() => undefined);
    }, 800);
    return () => window.clearTimeout(timeout);
  }, [flushQueue, state.project]);

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
