import { describe, expect, it } from 'vitest';
import { createEmptyProject, createNode, createEdge, fitViewport, normalizeProject } from '../src/project';

describe('project helpers', () => {
  it('migrates review nodes without losing their text, identity or relationships', () => {
    const review = { ...createNode('supplemental_info', 0, { x: 10, y: 20 }), type: 'review' as never, body: 'Original review' };
    const paragraph = createNode('paragraph', 1, { x: 100, y: 20 });
    const edge = createEdge(paragraph.id, review.id, 'review_target');
    const raw = { ...createEmptyProject(), nodes: [review, paragraph], edges: [edge] };
    const migrated = normalizeProject(raw);
    expect(migrated.nodes[0]).toMatchObject({ id: review.id, type: 'supplemental_info', body: 'Original review', position: review.position });
    expect(migrated.nodes[0].metadata.tags).toContain('legacy-review');
    expect(migrated.edges).toEqual(raw.edges);
    expect(raw.nodes[0].type).toBe('review');
    expect(normalizeProject(migrated)).toEqual(migrated);
  });
  it('fits nodes with negative and very large coordinates', () => {
    const nodes = [
      createNode('scene', 0, { x: -2200, y: -1400 }),
      createNode('paragraph', 1, { x: 5800, y: 3200 }),
    ];
    const viewport = fitViewport(nodes, 1200, 800);
    expect(viewport.scale).toBeGreaterThanOrEqual(0.05);
    expect(viewport.scale).toBeLessThan(1);
    for (const node of nodes) {
      const left = node.position.x * viewport.scale + viewport.x;
      const top = node.position.y * viewport.scale + viewport.y;
      expect(left).toBeGreaterThanOrEqual(0);
      expect(top).toBeGreaterThanOrEqual(0);
      expect(left + node.size.width * viewport.scale).toBeLessThanOrEqual(1200);
      expect(top + node.size.height * viewport.scale).toBeLessThanOrEqual(800);
    }
  });

  it('handles a 200-node project without a fixed canvas boundary', () => {
    const nodes = Array.from({ length: 200 }, (_, index) => createNode('scene', index, {
      x: (index % 20) * 620 - 4000,
      y: Math.floor(index / 20) * 360 - 1600,
    }));
    const viewport = fitViewport(nodes, 1440, 900);
    expect(Number.isFinite(viewport.x)).toBe(true);
    expect(Number.isFinite(viewport.y)).toBe(true);
    expect(viewport.scale).toBeGreaterThanOrEqual(0.05);
    expect(viewport.scale).toBeLessThan(0.2);
  });

  it('normalizes older project files without changing node content', () => {
    const project = createEmptyProject('Legacy');
    const node = createNode('paragraph', 0, { x: 10, y: 20 });
    node.body = 'Keep me';
    const normalized = normalizeProject({ ...project, nodes: [node], worldbook: undefined as never });
    expect(normalized.nodes[0].body).toBe('Keep me');
    expect(normalized.worldbook.entries).toEqual([]);
  });
});
