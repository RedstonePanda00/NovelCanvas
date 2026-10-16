import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyProject } from '../src/project';

const { saveProject } = vi.hoisted(() => ({ saveProject: vi.fn() }));
vi.mock('../src/api', () => ({ api: { saveProject } }));

import { ProjectStoreProvider, useProjectStore } from '../src/projectStore';

function Harness() {
  const store = useProjectStore();
  return <>
    <button onClick={() => store.openProject(createEmptyProject('Initial'))}>open</button>
    <button onClick={() => store.updateProject((project) => ({ ...project, title: 'Changed' }))}>change</button>
    <button onClick={() => store.updateProject((project) => ({ ...project, title: 'Latest' }))}>change again</button>
    <button onClick={() => store.undo()}>undo</button>
    <span data-testid="title">{store.project?.title}</span>
    <span data-testid="status">{store.saveStatus}</span>
  </>;
}

describe('ProjectStoreProvider', () => {
  beforeEach(() => { vi.useFakeTimers(); saveProject.mockReset(); saveProject.mockImplementation(async (project) => project); });

  it('records history and queues autosave', async () => {
    render(<ProjectStoreProvider><Harness /></ProjectStoreProvider>);
    fireEvent.click(screen.getByText('open'));
    fireEvent.click(screen.getByText('change'));
    expect(screen.getByTestId('title')).toHaveTextContent('Changed');
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(saveProject).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('undo'));
    expect(screen.getByTestId('title')).toHaveTextContent('Initial');
  });

  it('keeps an error state when persistence fails', async () => {
    saveProject.mockRejectedValueOnce(new Error('disk full'));
    render(<ProjectStoreProvider><Harness /></ProjectStoreProvider>);
    fireEvent.click(screen.getByText('open'));
    fireEvent.click(screen.getByText('change'));
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(screen.getByTestId('status')).toHaveTextContent('error');
  });

  it('serializes saves and coalesces the latest snapshot', async () => {
    let releaseFirst: ((value: unknown) => void) | undefined;
    saveProject
      .mockImplementationOnce((project) => new Promise((resolve) => { releaseFirst = () => resolve(project); }))
      .mockImplementation(async (project) => project);
    render(<ProjectStoreProvider><Harness /></ProjectStoreProvider>);
    fireEvent.click(screen.getByText('open'));
    fireEvent.click(screen.getByText('change'));
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(saveProject).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('change again'));
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(saveProject).toHaveBeenCalledTimes(1);
    await act(async () => { releaseFirst?.(undefined); await Promise.resolve(); });
    expect(saveProject).toHaveBeenCalledTimes(2);
    expect(saveProject.mock.calls[1][0].title).toBe('Latest');
  });
});
