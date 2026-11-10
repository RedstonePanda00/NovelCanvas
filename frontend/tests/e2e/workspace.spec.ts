import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

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
  await page.route('http://127.0.0.1:53173/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/api/project' && route.request().method() === 'GET') return route.fulfill({ json: project });
    if (path === '/api/project' && route.request().method() === 'PUT') {
      project = route.request().postDataJSON();
      return route.fulfill({ json: project });
    }
    if (path === '/api/app-config') return route.fulfill({ json: { providers: [], registeredModels: [] } });
    if (path === '/api/memory') return route.fulfill({ json: { id: 'project-memory', title: 'Memory', documents: [], embeddingModelId: null, sourceFingerprint: '', stale: true, updatedAt: '' } });
    return route.fulfill({ status: 404, json: { detail: `Unmocked ${path}` } });
  });
}

test.beforeEach(async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await page.locator('.canvas-stage').waitFor();
});

test('uploads an illustration, saves it and includes it in worldbook export', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop');
  await mockApi(page, 0);
  await page.reload();
  await page.locator('.node-palette button').filter({ hasText: /^image$/i }).click();
  await page.locator('.canvas-stage').click({ position: { x: 120, y: 80 } });
  const card = page.locator('.canvas-node.type-border-image');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  await card.getByLabel('Upload image', { exact: true }).setInputFiles({ name: 'castle.png', mimeType: 'image/png', buffer: png });
  await expect(card.locator('img')).toBeVisible();
  await card.locator('textarea').fill('A castle in the snow');
  await expect(page.locator('.save-indicator')).toContainText('Saved');
  await page.reload();
  await expect(card.locator('img')).toHaveAttribute('alt', 'A castle in the snow');
  await expect.poll(() => card.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  await page.screenshot({ path: testInfo.outputPath('image-node.png') });
  await page.locator('.primary-nav').getByRole('button', { name: /Worldbook/ }).click();
  await page.getByRole('button', { name: 'Add entry', exact: true }).click();
  await page.locator('.accordion-card summary').click();
  await page.getByLabel('Link image node').selectOption({ index: 1 });
  await expect(page.locator('.illustration-grid img')).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export Worldbook', exact: true }).click();
  const download = await downloadPromise;
  const data = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(data.imageNodes[0].image.fileName).toBe('castle.png');
  expect(data.imageNodes[0].worldbookEntryIds).toEqual([data.entries[0].id]);
  await page.locator('.illustration-grid').getByRole('button', { name: 'Unlink', exact: true }).click();
  await expect(page.locator('.illustration-grid img')).toHaveCount(0);
  page.on('dialog', dialog => dialog.accept());
  await page.locator('.page-content input[type=file][accept=".json,application/json"]').setInputFiles({ name: 'worldbook.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data)) });
  await expect(page.locator('.illustration-grid img')).toBeVisible();
});

test('new project opens with remembered model roles and respects reduced motion', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop');
  const fixture = projectFixture(0);
  const writer = { id: 'writer', displayName: 'Writer', enabled: true, capabilityTags: ['text'] };
  await page.route('**/api/app-config', route => route.fulfill({ json: { providers: [], registeredModels: [writer] } }));
  await page.route('**/api/project/new', route => route.fulfill({ json: {
    ...fixture, title: route.request().postDataJSON().title,
    settings: { ...fixture.settings, modelRouting: { paragraphGenerationModelId: 'writer' } },
  } }));
  page.on('dialog', dialog => dialog.accept(dialog.type() === 'prompt' ? 'Second book' : undefined));
  await page.locator('.project-menu summary').click();
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await expect(page.locator('.brand-copy')).toContainText('Second book');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByLabel('Paragraph', { exact: true })).toHaveValue('writer');
  await expect(page.locator('.page-heading')).toHaveCSS('animation-name', 'panelEnter');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('.page-heading')).toHaveCSS('animation-name', 'none');
});

test('keeps the canvas, selection and local undo across an external text edit', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop');
  const fixture = projectFixture(5);
  await page.route('**/api/project', async route => {
    if (route.request().method() === 'PUT') Object.assign(fixture, route.request().postDataJSON());
    await route.fulfill({ json: fixture });
  });
  await page.reload();
  const card = page.locator('[data-node-id="node-1"]');
  await page.locator('.navigator-list button').nth(1).click();
  const saved = page.waitForResponse(r => r.url().endsWith('/api/project') && r.request().method() === 'PUT');
  await card.locator('textarea').fill('Local draft');
  await saved;
  const original = await card.elementHandle();
  fixture.nodes[0].title = 'Changed by MCP';
  fixture.updatedAt = 'remote-revision';
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('[data-node-id="node-0"] input').first()).toHaveValue('Changed by MCP');
  expect(await original!.evaluate(el => el.isConnected)).toBe(true);
  await expect(card).toHaveClass(/selected/);
  await page.locator('.canvas-commandbar .icon-button').first().click();
  await expect(card.locator('textarea')).toHaveValue('Content for node 1');
  await expect(page.locator('[data-node-id="node-0"] input').first()).toHaveValue('Changed by MCP');
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
  await pushEvent(page, { type: 'delta', changes: [
    { index: 0, field: 'title', offset: 0, text: 'First scene' },
    { index: 0, field: 'body', offset: 0, text: 'Opening ' },
  ] });
  await pushEvent(page, { type: 'delta', changes: [{ index: 0, field: 'body', offset: 8, text: 'conflict' }] });
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

