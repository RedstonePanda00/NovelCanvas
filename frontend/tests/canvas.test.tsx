import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasWorkspace } from '../src/CanvasWorkspace';
import { ProjectStoreProvider, useProjectStore } from '../src/projectStore';
import { I18nProvider } from '../src/i18n';
import { createEmptyProject, createNode } from '../src/project';

const mocks = vi.hoisted(() => ({ getAppConfig: vi.fn(async () => ({ providers: [], registeredModels: [] })), saveProject: vi.fn(async (p) => p), assistantContext: vi.fn(async () => ({ nodes: [], worldbook: [] })), previewContext: vi.fn(), streamParagraphGeneration: vi.fn() }));
vi.mock('../src/api', () => ({ api: mocks }));
const a = createNode('paragraph', 0, { x: 0, y: 0 }); a.title = 'Alpha';
const b = createNode('paragraph', 1, { x: 500, y: 0 }); b.title = 'Beta';
function Harness() {
  const store = useProjectStore();
  const [active, setActive] = React.useState(true);
  return <>
    <button onClick={() => store.openProject({ ...createEmptyProject(), nodes: [a, b] })}>open fixture</button>
    <button onClick={() => setActive(!active)}>switch page</button>
    <button onClick={() => store.selectNode(b.id)}>select beta</button>
    <button onClick={store.undo}>undo fixture</button>
    <output data-testid="position">{store.project?.nodes[0].position.x}</output>
    <div hidden={!active}><CanvasWorkspace key={store.session} active={active} /></div>
  </>;
}
function setup() { render(<I18nProvider><ProjectStoreProvider><Harness /></ProjectStoreProvider></I18nProvider>); fireEvent.click(screen.getByText('open fixture')); }

describe('canvas lifecycle', () => {
  beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });
  it('discards late context responses after changing selection', async () => {
    let resolve!: (value: unknown) => void;
    mocks.previewContext.mockReturnValue(new Promise((r) => { resolve = r; }));
    setup();
    fireEvent.click(screen.getAllByText('Refresh')[0]);
    fireEvent.click(screen.getByText('select beta'));
    await act(async () => resolve({ items: [{ edgeId: 'old', title: 'Wrong context', semantic: 'reference', estimatedTokens: 1 }] }));
    expect(screen.queryByText('Wrong context')).not.toBeInTheDocument();
  });
  it('preserves generated drafts across page switches and clears them on project open', async () => {
    mocks.streamParagraphGeneration.mockImplementation(async (_p, _id, _mode, chunk) => { chunk('Candidate draft'); });
    setup();
    fireEvent.click(screen.getByText('Generate paragraph'));
    await waitFor(() => expect(screen.getByDisplayValue('Candidate draft')).toBeInTheDocument());
    fireEvent.click(screen.getByText('switch page'));
    fireEvent.click(screen.getByText('switch page'));
    expect(screen.getByDisplayValue('Candidate draft')).toBeInTheDocument();
    expect(screen.getAllByRole('textbox', { name: 'Content' })[1]).not.toBeDisabled();
    fireEvent.click(screen.getByText('open fixture'));
    expect(screen.queryByDisplayValue('Candidate draft')).not.toBeInTheDocument();
  });
  it('commits a drag once and restores its original position on undo', () => {
    vi.stubGlobal('PointerEvent', MouseEvent);
    setup();
    const header = document.querySelector('.node-header')!;
    fireEvent.pointerDown(header, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 30, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: 60, clientY: 40 });
    expect(screen.getByTestId('position')).toHaveTextContent('0');
    fireEvent.pointerUp(window);
    expect(screen.getByTestId('position')).toHaveTextContent('60');
    fireEvent.click(screen.getByText('undo fixture'));
    expect(screen.getByTestId('position')).toHaveTextContent('0');
    vi.unstubAllGlobals();
  });

  it('aborts an in-flight generation when opening another project', () => {
    let signal: AbortSignal | undefined;
    mocks.streamParagraphGeneration.mockImplementation((_p, _id, _mode, _chunk, received) => { signal = received; return new Promise(() => {}); });
    setup();
    fireEvent.click(screen.getByText('Generate paragraph'));
    expect(signal?.aborted).toBe(false);
    expect(screen.getAllByRole('textbox', { name: 'Content' })[1]).not.toBeDisabled();
    fireEvent.click(screen.getByText('open fixture'));
    expect(signal?.aborted).toBe(true);
  });
});
