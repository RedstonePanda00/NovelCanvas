import { describe, expect, it } from 'vitest';
import { createNode, createWorldbookEntry, validWorkflow } from '../src/project';
import { parseWorldbookImages } from '../src/projectOperations';
import { readImage } from '../src/ImageEditor';

describe('illustrations', () => {
  it('imports worldbook images with new node IDs and preserves entry links', () => {
    const entry = createWorldbookEntry();
    const image = { ...createNode('image', 0, { x: 0, y: 0 }), image: { fileName: 'a.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }, worldbookEntryIds: [entry.id, 'missing'] };
    const [imported] = parseWorldbookImages({ imageNodes: [image] }, [entry]);
    expect(imported.id).not.toBe(image.id);
    expect(imported.image).toEqual(image.image);
    expect(imported.worldbookEntryIds).toEqual([entry.id]);
    expect(validWorkflow(imported, 'generate-outline')).toBe(false);
    expect(parseWorldbookImages({ entries: [entry] }, [entry])).toEqual([]);
  });
  it('rejects remote image URLs in worldbook imports', () => {
    expect(() => parseWorldbookImages({ imageNodes: [{ type: 'image', title: 'Unsafe', worldbookEntryIds: [], image: { fileName: 'a', dataUrl: 'https://example.com/a.png' } }] }, [])).toThrow();
  });
  it('rejects unsupported and oversized uploads before reading', async () => {
    await expect(readImage(new File(['<svg/>'], 'a.svg', { type: 'image/svg+xml' }))).rejects.toThrow('Unsupported');
    await expect(readImage(new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'a.png', { type: 'image/png' }))).rejects.toThrow('2 MB');
  });
});
