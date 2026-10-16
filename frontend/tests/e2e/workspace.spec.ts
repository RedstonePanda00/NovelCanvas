import { expect, test, type Page, type Route } from '@playwright/test';

function assistantResult(route: Route, result: unknown) {
  return route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'done', response: result }) + '\n' });
}

function projectFixture(count = 200) {
  const timestamp = '2026-01-01T00:00:00.000Z';
  const nodes = Array.from({ length: count }, (_, index) => ({
    id: `node-${index}`,
    type: index % 4 === 0 ? 'paragraph' : 'scene',
    title: `Node ${index}`,
    body: `Content for node ${index}`,
    position: { x: (index % 20) * 620 - 4200, y: Math.floor(index / 20) * 360 - 1700 },
    size: { width: 340, height: 250 },
    metadata: { createdAt: timestamp, updatedAt: timestamp, sourceNodeIds: [], tags: [] },
    outlineLevel: null,
    targetWordCount: null,
    narrativeTask: null,
    childNodeIds: [],
  }));
  const edges = nodes.slice(1).map((node, index) => ({
    id: `edge-${index}`,
    sourceNodeId: nodes[index].id,
    targetNodeId: node.id,
    semantic: 'reference',
    label: 'reference',
    metadata: { createdAt: timestamp, updatedAt: timestamp, sourceNodeIds: [], tags: [] },
  }));
  return {
    version: '0.1.0', title: 'Large Fixture', nodes, edges, worldbook: { entries: [] },
    createdAt: timestamp, updatedAt: timestamp,
    settings: { defaultLanguage: 'en', defaultExportMode: 'assets', modelRouting: {}, modelGlobalPrompts: {} },
  };
}

async function mockApi(page: Page, count = 200) {
  let project = projectFixture(count);
  let revision = 0;
  await page.route('http://127.0.0.1:8000/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/api/project' && route.request().method() === 'GET') return route.fulfill({ json: project });
    if (path === '/api/project' && route.request().method() === 'PUT') {
      project = route.request().postDataJSON();
      return route.fulfill({ json: project });
    }
    if (path === '/api/app-config') return route.fulfill({ json: { providers: [], registeredModels: [] } });
    if (path === '/api/memory') return route.fulfill({ json: { id: 'project-memory', title: 'Memory', documents: [], embeddingModelId: null, sourceFingerprint: '', stale: true, updatedAt: '' } });
    if (path === '/api/assistant/context' || path === '/api/assistant/stream') {
      const input = route.request().postDataJSON();
      const targets = input.targetNodeIds ?? [input.targetNodeId];
      const automatic = project.edges.filter((edge) => targets.includes(edge.targetNodeId)).map((edge) => edge.sourceNodeId);
      const ids = [...targets, ...automatic, ...input.referenceNodeIds];
      const context = { nodes: project.nodes.filter((node) => ids.includes(node.id)).map((node) => ({ id: node.id, title: node.title, content: node.body })), worldbook: [] };
      if (path.endsWith('/context')) return route.fulfill({ json: context });
      revision += 1;
      const create = input.message.startsWith('Create');
      const edits = input.message.startsWith('Discuss') ? [] : [{ targetNodeId: input.targetNodeId, operation: create ? 'create' : 'replace', nodeType: create ? 'character' : project.nodes.find((node) => node.id === input.targetNodeId)!.type, title: create ? 'Designed character' : 'Revised scene', body: `Candidate body ${revision}` }];
      return assistantResult(route, { reply: `Design rationale ${revision}`, edits, context });
    }
    return route.fulfill({ status: 404, json: { detail: `Unmocked ${path}` } });
  });
}

test.beforeEach(async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await page.locator('.canvas-stage').waitFor();
});

test('loads, fits and edits a 200-node project', async ({ page }) => {
  await expect(page.locator('.canvas-node')).toHaveCount(200);
  await expect(page.locator('.zoom-readout')).toHaveText(/[5-9]%/);
  const stage = page.locator('.canvas-stage');
  await page.locator('.node-palette button').first().click();
  await stage.click({ position: { x: 24, y: 24 } });
  await expect(page.locator('.canvas-node')).toHaveCount(201);
  await expect(page.locator('.save-indicator')).toContainText(/Unsaved|Saving|Saved/);
});

test('supports bilingual UI and persists locale', async ({ page }) => {
  await page.getByRole('button', { name: '中文' }).click();
  await expect(page.getByRole('button', { name: '画布' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('novel-canvas-ui-locale'))).toBe('zh-CN');
});

test('panning across node text preserves selection and does not select text', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop');
  await page.locator('.navigator-list button').first().click();
  await page.getByRole('button', { name: 'Fit selection', exact: true }).click();
  const stage = page.locator('.canvas-stage');
  const node = page.locator('[data-node-id="node-0"]');
  const bounds = await stage.boundingBox();
  if (!bounds) throw new Error('Missing canvas');
  const before = await page.locator('.canvas-world').getAttribute('style');
  await page.mouse.move(bounds.x + 12, bounds.y + 12);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 130, bounds.y + 160, { steps: 8 });
  await expect(page.locator('body')).toHaveClass(/canvas-drag-active/);
  await page.mouse.up();
  await expect(page.locator('.canvas-world')).not.toHaveAttribute('style', before!);
  await expect(node).toHaveClass(/selected/);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('');
  await expect(page.locator('body')).not.toHaveClass(/canvas-drag-active/);
  // Normal text editing and selection must still work after the gesture.
  const body = node.locator('textarea');
  await body.focus();
  await page.keyboard.press('Control+a');
  expect(await body.evaluate((el) => (el as HTMLTextAreaElement).selectionEnd - (el as HTMLTextAreaElement).selectionStart)).toBeGreaterThan(0);
});

test('edits and undoes a node in a 1000-node PC project', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop');
  await mockApi(page, 1000);
  await page.reload();
  await expect(page.locator('.canvas-node')).toHaveCount(1000);
  await page.locator('.navigator-list button').first().click();
  await page.getByRole('button', { name: 'Fit selection', exact: true }).click();
  const node = page.locator('[data-node-id="node-0"]');
  const body = node.locator('textarea');
  await body.fill('Revised manuscript');
  await expect(page.locator('.save-indicator')).toContainText('Saved');
  const zoom = await page.locator('.zoom-readout').innerText();
  await body.hover();
  await page.mouse.wheel(0, 100);
  await expect(page.locator('.zoom-readout')).toHaveText(zoom);
  const before = await node.evaluate((element) => (element as HTMLElement).style.left);
  const handle = await node.locator('.node-type').boundingBox();
  if (!handle) throw new Error('Missing drag handle');
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 60, handle.y + handle.height / 2 + 30, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => node.evaluate((element) => (element as HTMLElement).style.left)).not.toBe(before);
  await page.getByTitle('Undo', { exact: true }).click();
  await expect.poll(() => node.evaluate((element) => (element as HTMLElement).style.left)).toBe(before);
  await expect(body).toHaveValue('Revised manuscript');
});

test('keeps mobile navigation and scrolling accessible', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'mobile-only assertion');
  const metrics = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    viewport: innerWidth,
    overflow: getComputedStyle(document.body).overflow,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  expect(metrics.width).toBeLessThanOrEqual(metrics.viewport);
  expect(metrics.overflow).not.toBe('hidden');
  expect(metrics.scrollHeight).toBeGreaterThan(844);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' }).first()).toBeVisible();
});

async function openChat(page: Page) {
  await page.getByRole('button', { name: 'Expand chat', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Writing chat' });
  await panel.getByRole('button', { name: '+ Attach selected node', exact: true }).click();
  return panel;
}

test('discusses, directly edits, iterates and rolls back after reload', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop');
  const panel = await openChat(page);
  await panel.getByLabel('Request / feedback', { exact: true }).fill('Discuss a motive and explain why.');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(panel.getByRole('log')).toContainText('Design rationale 1');
  await expect(page.locator('[data-node-id="node-0"] textarea')).toHaveValue('Content for node 0');
  await panel.getByLabel('Request / feedback', { exact: true }).fill('Make the dialogue shorter. Keep the ending.');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('[data-node-id="node-0"] textarea')).toHaveValue('Candidate body 2');
  await panel.getByRole('button', { name: 'Continue revising', exact: true }).click();
  await panel.getByLabel('Request / feedback', { exact: true }).fill('Keep the dialogue but improve the ending.');
  const sent = page.waitForRequest((request) => request.url().endsWith('/api/assistant/stream'));
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  expect((await sent).postDataJSON().message).toContain('Candidate body 2');
  await expect(page.locator('[data-node-id="node-0"] textarea')).toHaveValue('Candidate body 3');
  await expect(page.locator('.save-indicator')).toContainText('Saved');
  await page.reload();
  await page.getByRole('button', { name: 'Expand chat', exact: true }).click();
  await expect(panel.locator('.chat-change')).toHaveCount(1);
  await panel.getByRole('button', { name: 'Compare', exact: true }).last().click();
  const dialog = page.getByRole('dialog', { name: 'Version comparison' });
  await expect(dialog).toContainText('Candidate body 2');
  await expect(dialog).toContainText('Candidate body 3');
  await dialog.getByRole('button', { name: 'Roll back', exact: true }).click();
  await expect(page.locator('[data-node-id="node-0"] textarea')).toHaveValue('Candidate body 2');
  await dialog.getByRole('button', { name: 'Close comparison' }).click();
  await expect(panel.getByRole('button', { name: 'Roll back', exact: true })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/workbench-pc.png', fullPage: true });
});

test('creates a clean character and rolls back its creation', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop');
  const panel = await openChat(page);
  await panel.getByLabel('Request / feedback', { exact: true }).fill('Create a character name and personality.');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.canvas-node')).toHaveCount(201);
  const created = page.locator('.canvas-node').last();
  await expect(created.locator('textarea')).toHaveValue('Candidate body 1');
  await expect(created.locator('input').first()).toHaveValue('Designed character');
  await panel.getByRole('button', { name: 'Roll back', exact: true }).click();
  await expect(page.locator('.canvas-node')).toHaveCount(200);
});

test('searches a source and adds a directed relationship without duplicates', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop');
  const picker = page.getByRole('region', { name: 'Add relationship', exact: true });
  await picker.getByLabel('Search reference nodes').fill('Node 199');
  await picker.getByLabel('Source node', { exact: true }).selectOption('node-199');
  await picker.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('.edge-hit')).toHaveCount(200);
  await picker.getByLabel('Source node', { exact: true }).selectOption('node-199');
  await picker.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('.edge-hit')).toHaveCount(200);
});

test('drags a connection onto the whole target node and confirms its meaning', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop');
  await mockApi(page, 2); await page.reload();
  await page.getByRole('button', { name: 'Fit all', exact: true }).click();
  const source = page.locator('[data-node-id="node-1"]');
  const target = page.locator('[data-node-id="node-0"]');
  const handle = await source.getByRole('button', { name: 'Drag connection' }).boundingBox();
  const body = await target.locator('textarea').boundingBox();
  if (!handle || !body) throw new Error('Missing connection targets');
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(body.x + body.width / 2, body.y + body.height / 2, { steps: 5 });
  await expect(page.locator('.connection-preview')).toBeVisible();
  await expect(target).toHaveClass(/connection-target/);
  await page.mouse.up();
  const dialog = page.getByRole('dialog', { name: 'Confirm relationship' });
  await expect(dialog).toContainText('Node 1 → Node 0');
  await dialog.getByRole('combobox', { name: 'Relationship', exact: true }).selectOption('must_follow');
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('.edge-hit')).toHaveCount(2);
  await expect(page.locator('.connection-preview')).toHaveCount(0);
});

test('failed discussion keeps feedback and leaves manuscript unchanged', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop');
  await page.route('**/api/assistant/stream', (route) => route.fulfill({ status: 400, json: { detail: 'Select a chat model in Settings.' } }));
  const panel = await openChat(page);
  await panel.getByLabel('Request / feedback', { exact: true }).fill('Keep this feedback after failure');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('Select a chat model');
  await expect(panel.getByLabel('Request / feedback', { exact: true })).toHaveValue('Keep this feedback after failure');
  await expect(page.locator('[data-node-id="node-0"] textarea')).toHaveValue('Content for node 0');
});

test('uses a linked review as editable feedback without automatically applying it', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop');
  const project = projectFixture(2);
  project.nodes[1].type = 'review'; project.nodes[1].body = 'Shorten the opening. Keep the ending.';
  project.edges[0].semantic = 'review_target';
  await page.route('**/api/project', (route) => route.fulfill({ json: project }));
  await page.reload();
  const panel = await openChat(page);
  await panel.getByText('Use review feedback', { exact: true }).click();
  await panel.getByRole('button', { name: 'Use as editable feedback' }).click();
  await expect(panel.getByLabel('Request / feedback', { exact: true })).toHaveValue(project.nodes[1].body);
  await expect(page.locator('[data-node-id="node-0"] textarea')).toHaveValue('Content for node 0');
});

test('drops a target into collapsed chat, expands access, and keeps drafts when selection changes', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop');
  const panel = page.getByRole('region', { name: 'Writing chat' });
  await page.locator('.navigator-list button').nth(2).dragTo(panel);
  await expect(panel.getByLabel('Chat targets')).toContainText('Node 2');
  await panel.getByLabel('Scope', { exact: true }).selectOption('attached');
  await panel.locator('.assistant-context > summary').click();
  await expect(panel.getByText('↳ Node 1', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Allow reading: Node 0', exact: true }).click();
  await expect(panel.getByText('↳ Node 0', { exact: true })).toBeVisible();
  await panel.getByLabel('Request / feedback', { exact: true }).fill('Unsent design idea');
  await panel.getByRole('button', { name: 'Collapse chat', exact: true }).click();
  await page.locator('.navigator-list button').nth(3).click();
  await panel.getByRole('button', { name: 'Expand chat', exact: true }).click();
  await expect(panel.getByLabel('Request / feedback', { exact: true })).toHaveValue('Unsent design idea');
  await expect(panel.getByLabel('Chat targets')).toContainText('Node 2');
  await expect(panel.getByLabel('Chat targets')).not.toContainText('Node 3');
});

test('keeps a concurrent manual edit and records the agent result as a conflict', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop');
  await page.locator('.navigator-list button').first().click();
  await page.getByRole('button', { name: 'Fit selection', exact: true }).click();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/assistant/stream', async (route) => {
    await hold;
    await assistantResult(route, { reply: 'Updated', edits: [{ targetNodeId: 'node-0', operation: 'replace', nodeType: 'paragraph', title: 'Change', body: 'Agent replacement' }], context: { nodes: [], worldbook: [] } });
  });
  const panel = await openChat(page);
  await panel.getByLabel('Request / feedback', { exact: true }).fill('Change the opening');
  const sent = page.waitForRequest('**/api/assistant/stream');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await sent;
  const body = page.locator('[data-node-id="node-0"] textarea');
  await body.fill('My newer manual edit');
  release();
  await expect(panel.locator('.chat-change')).toContainText('Text changed');
  await expect(body).toHaveValue('My newer manual edit');
  await panel.getByRole('button', { name: 'Accept candidate', exact: true }).click();
  await expect(body).toHaveValue('My newer manual edit');
});

test('attaches multiple targets and sends without writing during general discussion', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop');
  await page.getByRole('button', { name: 'Expand chat', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Writing chat' });
  await panel.getByLabel('Request / feedback', { exact: true }).fill('Discuss a theme');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(panel.getByRole('log')).toContainText('Design rationale 1');
  await page.locator('.navigator-list button').nth(1).dragTo(panel.locator('.chat-targets'));
  await page.locator('.navigator-list button').nth(2).dragTo(panel.locator('.chat-targets'));
  await expect(panel.locator('.chat-target')).toHaveCount(2);
  await panel.getByLabel('Request / feedback', { exact: true }).fill('Discuss these scenes');
  const sent = page.waitForRequest('**/api/assistant/stream');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  expect((await sent).postDataJSON().targetNodeIds).toEqual(['node-1', 'node-2']);
  await expect(panel.getByRole('log')).toContainText('Design rationale 2');
  await expect(panel.locator('.chat-change')).toHaveCount(0);
  const composer = await panel.locator('.chat-composer').boundingBox();
  expect(composer!.y + composer!.height).toBeLessThanOrEqual(1000);
});

test('keeps the original inspector visible beside chat and restores separate conversations', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop');
  const panel = await openChat(page);
  const inspector = page.locator('.inspector-panel');
  await expect(inspector.getByRole('region', { name: 'Add relationship', exact: true })).toBeVisible();
  const inspectorBox = await inspector.boundingBox();
  const chatBox = await page.locator('.chat-sidebar').boundingBox();
  expect(chatBox!.x).toBeGreaterThanOrEqual(inspectorBox!.x + inspectorBox!.width - 1);
  await panel.getByLabel('Request / feedback', { exact: true }).fill('Discuss the first scene');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(panel.getByRole('log')).toContainText('Design rationale 1');
  await panel.getByLabel('Request / feedback', { exact: true }).fill('First unfinished idea');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  const current = page.getByRole('region', { name: 'Writing chat' });
  await expect(current.locator('.chat-target')).toHaveCount(0);
  await expect(current.getByLabel('Request / feedback', { exact: true })).toHaveValue('');
  await expect(current.getByRole('log')).not.toContainText('Design rationale 1');
  await current.getByLabel('Request / feedback', { exact: true }).fill('Second unfinished idea');
  await page.locator('[data-conversation-id="__chat__"]').click();
  await expect(current.getByLabel('Request / feedback', { exact: true })).toHaveValue('First unfinished idea');
  await expect(current.locator('.chat-target')).toHaveCount(1);
  await expect(page.locator('.save-indicator')).toContainText('Saved');
  await page.reload();
  await page.getByRole('button', { name: 'Expand chat', exact: true }).click();
  await expect(current.getByLabel('Request / feedback', { exact: true })).toHaveValue('First unfinished idea');
  await page.locator('[data-conversation-id^="__chat__:"]').click();
  await expect(current.getByLabel('Request / feedback', { exact: true })).toHaveValue('Second unfinished idea');
  await page.getByRole('button', { name: 'Fit selection', exact: true }).click();
  await page.screenshot({ path: 'test-results/chat-layout.png', fullPage: true });
  await current.getByRole('button', { name: 'Collapse chat', exact: true }).click();
  await expect(inspector).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Conversations', exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: 'Conversations', exact: true }).getByRole('button', { name: 'Collapse conversations', exact: true }).click();
  expect((await page.locator('.chat-sidebar').boundingBox())!.width).toBeLessThan(50);
});

test('Cursor-style chat keeps navigation independent and moves the new-chat composer after sending', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop');
  await page.getByRole('button', { name: 'Expand chat', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Writing chat' });
  const list = page.getByRole('navigation', { name: 'Conversations', exact: true });
  const composer = panel.locator('.chat-composer');
  await expect(panel.getByLabel('Mode', { exact: true }).locator('option')).toHaveCount(1);
  await expect(panel.getByLabel('Mode', { exact: true })).toHaveValue('agent');
  expect(await page.locator('.chat-sidebar').evaluate((element) => getComputedStyle(element).getPropertyValue('--surface-1').trim())).toBe(await page.locator('.inspector-panel').evaluate((element) => getComputedStyle(element).getPropertyValue('--surface-1').trim()));
  const originalTop = (await composer.boundingBox())!.y;
  const panelTop = (await panel.boundingBox())!.y;
  expect(originalTop - panelTop).toBeLessThan(80);
  await expect(list).toBeVisible();
  await page.screenshot({ path: 'test-results/cursor-chat-empty.png', fullPage: true });
  await panel.getByLabel('Request / feedback', { exact: true }).fill('Discuss the ending');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(panel.getByRole('log')).toContainText('Design rationale');
  expect((await composer.boundingBox())!.y).toBeGreaterThan(originalTop + 300);
  await list.getByRole('button', { name: 'New conversation', exact: true }).click();
  await panel.getByLabel('Request / feedback', { exact: true }).fill('A separate unfinished idea');
  await list.getByLabel('Search conversations').fill('ending');
  await expect(list.locator('.chat-conversation-item')).toHaveCount(1);
  await list.locator('.chat-conversation-item').click();
  await expect(panel.getByRole('log')).toContainText('Design rationale');
  await list.getByLabel('Search conversations').fill('absent title');
  await expect(list).toContainText('No matching conversations');
  await list.getByLabel('Search conversations').fill('');
  await list.getByRole('button', { name: 'Collapse conversations', exact: true }).click();
  await expect(list).toBeHidden();
  await expect(panel.getByLabel('Request / feedback', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Expand conversations', exact: true }).click();
  await panel.getByRole('button', { name: 'Collapse chat', exact: true }).click();
  await expect(list).toBeVisible();
  await expect(panel.getByLabel('Request / feedback', { exact: true })).toBeHidden();
  await list.locator('[data-conversation-id^="__chat__:"]').click();
  await expect(panel.getByLabel('Request / feedback', { exact: true })).toHaveValue('A separate unfinished idea');
  await expect(page.locator('.inspector-panel')).toBeVisible();
});

test('renders report blocks, copies the whole report and retains it for follow-up after reload', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop');
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as unknown as { copiedReport: string }).copiedReport = text; } } }));
  await page.route('**/api/assistant/stream', (route) => assistantResult(route, { reply: 'Here is the report.', blocks: [{ title: 'Continuity report', body: 'Finding: the promise is unresolved.\nSuggestion: clarify the choice.' }], edits: [], context: { nodes: [], worldbook: [] } }));
  await page.reload();
  const panel = await openChat(page);
  await panel.getByLabel('Request / feedback', { exact: true }).fill('Review this scene and give me a report');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  const report = panel.getByRole('region', { name: 'Continuity report' });
  await expect(report.locator('pre')).toContainText('promise is unresolved');
  await expect(page.locator('[data-node-id="node-0"] textarea')).toHaveValue('Content for node 0');
  await report.locator('summary').click();
  await expect(report.locator('pre')).toBeHidden();
  await report.getByRole('button', { name: 'Copy full text', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { copiedReport: string }).copiedReport)).toBe('Continuity report\n\nFinding: the promise is unresolved.\nSuggestion: clarify the choice.');
  await expect(page.locator('.save-indicator')).toContainText('Saved');
  await page.reload();
  await page.getByRole('button', { name: 'Expand chat', exact: true }).click();
  await expect(report.locator('pre')).toContainText('promise is unresolved');
  await panel.getByLabel('Request / feedback', { exact: true }).fill('Explain the first finding');
  const sent = page.waitForRequest('**/api/assistant/stream');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  expect((await sent).postDataJSON().history[1].content).toContain('Finding: the promise is unresolved.');
  await expect(panel.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  await expect(panel.locator('.chat-block')).toHaveCount(1);
  await page.screenshot({ path: 'test-results/report-block.png', fullPage: true });
});

test('deletes conversations and their change history without undoing manuscript edits', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop');
  const panel = await openChat(page);
  await panel.getByLabel('Request / feedback', { exact: true }).fill('Change this scene');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('[data-node-id="node-0"] textarea')).toHaveValue('Candidate body 1');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await panel.getByLabel('Request / feedback', { exact: true }).fill('Keep this conversation');
  await page.locator('[data-conversation-id="__chat__"]').click();
  await page.getByRole('button', { name: 'Delete conversation', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Delete conversation' });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.chat-conversation-item')).toHaveCount(2);
  await page.getByRole('button', { name: 'Delete conversation', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Delete conversation' });
  await dialog.getByRole('button', { name: 'Confirm delete', exact: true }).click();
  await expect(page.locator('.chat-conversation-item')).toHaveCount(1);
  await expect(panel.getByLabel('Request / feedback', { exact: true })).toHaveValue('Keep this conversation');
  await expect(page.locator('[data-node-id="node-0"] textarea')).toHaveValue('Candidate body 1');
  await expect(panel.locator('.chat-change')).toHaveCount(0);
  await expect(page.locator('.save-indicator')).toContainText('Saved');
  await page.reload();
  await page.getByRole('button', { name: 'Expand chat', exact: true }).click();
  await expect(page.locator('.chat-conversation-item')).toHaveCount(1);
});

test('deleting the last conversation cancels its request and does not resurrect it', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop');
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/assistant/stream', async (route) => {
    await hold;
    await assistantResult(route, { reply: 'Late response', edits: [{ targetNodeId: 'node-0', operation: 'replace', nodeType: 'paragraph', title: 'Late change', body: 'Late text' }], context: { nodes: [], worldbook: [] } }).catch(() => undefined);
  });
  const panel = await openChat(page);
  await panel.getByLabel('Request / feedback', { exact: true }).fill('Change this scene');
  const sent = page.waitForRequest('**/api/assistant/stream');
  await panel.getByRole('button', { name: 'Send', exact: true }).click(); await sent;
  await page.getByRole('button', { name: 'Delete conversation', exact: true }).click();
  await page.getByRole('dialog', { name: 'Delete conversation' }).getByRole('button', { name: 'Confirm delete', exact: true }).click();
  release();
  await expect(panel.getByLabel('Request / feedback', { exact: true })).toHaveValue('');
  await expect(page.locator('.save-indicator')).toContainText('Saved');
  await expect(panel.getByRole('log')).not.toContainText('Late response');
  await expect(page.locator('[data-node-id="node-0"] textarea')).toHaveValue('Content for node 0');
  await expect(page.getByRole('button', { name: 'Delete conversation', exact: true })).toBeDisabled();
});

async function installControlledStream(page: Page, endpoint: string) {
  await page.addInitScript((path) => {
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      if (String(input).endsWith(path)) {
        return new Response(new ReadableStream<Uint8Array>({ start(controller) {
          (window as unknown as { pushEvent: (event: unknown) => void; closeEvents: () => void }).pushEvent = (event) => controller.enqueue(new TextEncoder().encode(JSON.stringify(event) + '\n'));
          (window as unknown as { closeEvents: () => void }).closeEvents = () => controller.close();
        } }), { headers: { 'Content-Type': 'application/x-ndjson' } });
      }
      return original(input, init);
    };
  }, endpoint);
}

async function pushEvent(page: Page, event: unknown, close = false) {
  await page.evaluate(({ event, close }) => {
    const stream = window as unknown as { pushEvent: (event: unknown) => void; closeEvents: () => void };
    stream.pushEvent(event); if (close) stream.closeEvents();
  }, { event, close });
}

test('chat displays streamed text before completion and commits only the validated result', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop');
  await installControlledStream(page, '/api/assistant/stream'); await page.reload();
  const panel = await openChat(page);
  await panel.getByLabel('Request / feedback', { exact: true }).fill('Change the scene');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await pushEvent(page, { type: 'preview', reply: 'First streamed words', blocks: [], edits: [{ title: 'Scene', body: 'Half a revision' }] });
  await expect(panel.locator('.streaming')).toContainText('First streamed words');
  await expect(panel.locator('.streaming')).toContainText('Half a revision');
  await expect(page.locator('[data-node-id="node-0"] textarea')).toHaveValue('Content for node 0');
  await pushEvent(page, { type: 'done', response: { reply: 'Complete response', edits: [{ targetNodeId: 'node-0', operation: 'replace', nodeType: 'paragraph', title: 'Scene', body: 'Finished revision' }], context: { nodes: [], worldbook: [] } } }, true);
  await expect(page.locator('[data-node-id="node-0"] textarea')).toHaveValue('Finished revision');
  await expect(panel.locator('.streaming')).toHaveCount(0);
});

test('outline reserves the requested scene nodes before streaming and fills the same slots', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop');
  const project = projectFixture(1); project.nodes[0].type = 'outline';
  await page.route('**/api/project', (route) => route.fulfill({ json: route.request().method() === 'PUT' ? route.request().postDataJSON() : project }));
  await installControlledStream(page, '/api/plans/scenes/stream'); await page.reload();
  await page.getByLabel('Scene count', { exact: true }).fill('3');
  await page.getByRole('button', { name: 'Generate scenes', exact: true }).click();
  await expect(page.locator('.canvas-node.pending')).toHaveCount(3);
  const ids = await page.locator('.canvas-node.pending').evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.nodeId));
  await expect(page.locator('.plan-review-bar').getByRole('button', { name: 'Accept', exact: true })).toBeDisabled();
  await pushEvent(page, { type: 'preview', nodes: [{ title: 'First scene', body: 'Opening conflict' }] });
  await expect(page.locator('.canvas-node.pending textarea').first()).toHaveValue('Opening conflict');
  await expect(page.locator('.canvas-node.pending textarea').nth(1)).toHaveValue('');
  const nodes = [1, 2, 3].map((index) => ({ title: `Scene ${index}`, body: `Complete scene brief ${index}` }));
  await pushEvent(page, { type: 'done', nodes }, true);
  await expect(page.locator('.canvas-node.pending textarea').nth(2)).toHaveValue('Complete scene brief 3');
  expect(await page.locator('.canvas-node.pending').evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.nodeId))).toEqual(ids);
  await page.locator('.plan-review-bar').getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(page.locator('.canvas-node.pending')).toHaveCount(0);
  await expect(page.locator('.canvas-node')).toHaveCount(4);
  await expect(page.locator('.edge-hit')).toHaveCount(3);
});

test('project agent locates unattached nodes, persists a checkpoint and resumes after reload', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop');
  let firstRequest: Record<string, unknown> | undefined;
  let resumedRequest: Record<string, unknown> | undefined;
  await page.route('**/api/assistant/stream', async (route) => {
    const input = route.request().postDataJSON();
    if (!input.checkpoint) {
      firstRequest = input;
      return route.fulfill({ contentType: 'application/x-ndjson', body: [
        { type: 'checkpoint', checkpoint: { version: 1, step: 3, memory: 'Node 5 located; ready to finish' } },
        { type: 'activity', step: 2, tool: 'delegate_parallel', title: '1 · Review scenes', message: 'Worker one checked continuity.', changedCount: 0 },
        { type: 'activity', step: 2, tool: 'delegate_parallel', title: '2 · Review characters', message: 'Worker two checked motivation.', changedCount: 0 },
        { type: 'activity', step: 3, tool: 'read_node', nodeId: 'node-5', changedCount: 0, message: 'Located the relevant scene.' },
        { type: 'error', error: { code: 'agent_failed', message: 'Temporary provider interruption' } },
      ].map((event) => JSON.stringify(event)).join('\n') + '\n' });
    }
    resumedRequest = input;
    return assistantResult(route, { reply: 'Checked the located scene.', context: { nodes: [], worldbook: [] }, edits: [
      { targetNodeId: 'node-5', operation: 'replace', nodeType: 'scene', title: 'Node 5', body: 'The repetition is removed.', baseBody: 'Content for node 5' },
    ] });
  });
  await page.getByRole('button', { name: 'Expand chat', exact: true }).click();
  let panel = page.getByRole('region', { name: 'Writing chat' });
  await expect(panel.getByLabel('Scope', { exact: true })).toHaveValue('project');
  await panel.getByLabel('Request / feedback', { exact: true }).fill('Find and remove repetitive descriptions throughout the novel');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Resume task', exact: true })).toBeVisible();
  expect(firstRequest?.targetNodeIds).toEqual([]);
  expect(firstRequest?.scope).toBe('project');
  await expect(panel.locator('.agent-activity')).toContainText('Located the relevant scene.');
  await expect(panel.locator('.agent-activity')).toContainText('Worker one checked continuity.');
  await expect(panel.locator('.agent-activity')).toContainText('Worker two checked motivation.');
  await page.screenshot({ path: 'test-results/agent-workflow.png', fullPage: true });
  await expect(page.locator('[data-node-id="node-5"] textarea')).toHaveValue('Content for node 5');
  await expect(page.locator('.save-indicator')).toContainText('Saved');
  await page.reload();
  await page.getByRole('button', { name: 'Expand chat', exact: true }).click();
  panel = page.getByRole('region', { name: 'Writing chat' });
  await expect(panel.locator('.agent-activity')).toContainText('Worker one checked continuity.');
  await expect(panel.locator('.agent-activity')).toContainText('Worker two checked motivation.');
  await panel.getByRole('button', { name: 'Resume task', exact: true }).click();
  await expect(page.locator('[data-node-id="node-5"] textarea')).toHaveValue('The repetition is removed.');
  expect(resumedRequest?.checkpoint).toMatchObject({ step: 3, memory: 'Node 5 located; ready to finish' });
  await panel.locator('.chat-change').getByRole('button', { name: 'Roll back', exact: true }).click();
  await expect(page.locator('[data-node-id="node-5"] textarea')).toHaveValue('Content for node 5');
});

test('project agent creates dependent nodes without attachments', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop');
  await page.route('**/api/assistant/stream', (route) => assistantResult(route, { reply: 'Designed the character and scene.', context: { nodes: [], worldbook: [] }, edits: [
    { targetNodeId: '', proposedNodeId: 'agent-character', operation: 'create', nodeType: 'character', title: 'Mira', body: 'A reckless navigator.', creationSourceNodeIds: [] },
    { targetNodeId: 'agent-character', proposedNodeId: 'agent-scene', operation: 'create', nodeType: 'scene', title: 'The crossing', body: 'Mira risks the crossing.', creationSourceNodeIds: ['agent-character'] },
  ] }));
  await page.getByRole('button', { name: 'Expand chat', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Writing chat' });
  await panel.getByLabel('Request / feedback', { exact: true }).fill('Create a navigator and a scene based on her character');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('[data-node-id="agent-character"] textarea')).toHaveValue('A reckless navigator.');
  await expect(page.locator('[data-node-id="agent-scene"] textarea')).toHaveValue('Mira risks the crossing.');
  await expect(panel.locator('.chat-change')).toHaveCount(2);
  await panel.locator('.chat-change').nth(1).getByRole('button', { name: 'Roll back', exact: true }).click();
  await panel.locator('.chat-change').nth(0).getByRole('button', { name: 'Roll back', exact: true }).click();
  await expect(page.locator('[data-node-id="agent-character"]')).toHaveCount(0);
  await expect(page.locator('[data-node-id="agent-scene"]')).toHaveCount(0);
});

test('project agent atomically deletes a node with its relationships and rolls back the complete batch', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop');
  await mockApi(page, 3); await page.reload();
  const snapshot = projectFixture(3);
  await page.route('**/api/assistant/stream', (route) => assistantResult(route, {
    reply: 'Removed the obsolete scene and updated the opening.', context: { nodes: [], worldbook: [] },
    edits: [{ targetNodeId: 'node-0', operation: 'replace', nodeType: 'paragraph', title: 'Node 0', body: 'New opening', baseBody: 'Content for node 0' }],
    mutations: [
      { kind: 'edge', targetId: 'edge-1', before: snapshot.edges[1], after: null, index: 1 },
      { kind: 'node_delete', targetId: 'node-1', before: snapshot.nodes[1], after: null, index: 1 },
      { kind: 'edge', targetId: 'edge-0', before: snapshot.edges[0], after: null, index: 0 },
    ],
  }));
  await page.getByRole('button', { name: 'Expand chat', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Writing chat' });
  await panel.getByLabel('Request / feedback', { exact: true }).fill('Delete the obsolete scene and update the opening');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('[data-node-id="node-0"] textarea')).toHaveValue('New opening');
  await expect(page.locator('[data-node-id="node-1"]')).toHaveCount(0);
  await expect(page.locator('.edge-hit')).toHaveCount(0);
  await expect(panel.locator('.chat-structure-changes')).toContainText('Deleted node');
  await panel.getByRole('button', { name: 'Roll back entire batch', exact: true }).click();
  await expect(page.locator('[data-node-id="node-0"] textarea')).toHaveValue('Content for node 0');
  await expect(page.locator('[data-node-id="node-1"] textarea')).toHaveValue('Content for node 1');
  await expect(page.locator('.edge-hit')).toHaveCount(2);
});
