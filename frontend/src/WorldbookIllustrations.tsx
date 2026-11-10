import { ImageEditor } from './ImageEditor';
import { useI18n } from './i18n';
import { createNode } from './project';
import { useProjectStore } from './projectStore';

export function WorldbookIllustrations({ entryId }: { entryId: string }) {
  const { project, updateProject } = useProjectStore();
  const { locale } = useI18n();
  const zh = locale === 'zh-CN';
  if (!project) return null;
  const images = project.nodes.filter(node => node.type === 'image');
  const linked = images.filter(node => node.worldbookEntryIds?.includes(entryId));
  return <section className="worldbook-illustrations">
    <strong>{zh ? '插画' : 'Illustrations'}</strong>
    <select aria-label={zh ? '关联图片节点' : 'Link image node'} value="" onChange={event => {
      const id = event.target.value;
      if (id) updateProject(current => ({ ...current, nodes: current.nodes.map(node => node.id === id ? { ...node, worldbookEntryIds: [...(node.worldbookEntryIds ?? []), entryId] } : node) }));
    }}><option value="">{zh ? '选择已有图片节点…' : 'Choose an existing image node…'}</option>{images.filter(node => !node.worldbookEntryIds?.includes(entryId)).map(node => <option key={node.id} value={node.id}>{node.title}</option>)}</select>
    <div className="illustration-grid">{linked.map(node => <div key={node.id}>
      <strong>{node.title}</strong>
      <ImageEditor image={node.image} alt={node.body || node.title} onChange={image => updateProject(current => ({ ...current, nodes: current.nodes.map(item => item.id === node.id ? { ...item, image } : item) }))} />
      <button type="button" className="secondary" onClick={() => updateProject(current => ({ ...current, nodes: current.nodes.map(item => item.id === node.id ? { ...item, worldbookEntryIds: item.worldbookEntryIds?.filter(id => id !== entryId) } : item) }))}>{zh ? '取消关联' : 'Unlink'}</button>
    </div>)}</div>
    <ImageEditor alt="" onChange={image => {
      if (!image) return;
      updateProject(current => {
        const node = createNode('image', current.nodes.length, { x: 80 + current.nodes.length % 4 * 380, y: 80 + Math.floor(current.nodes.length / 4) * 480 });
        return { ...current, nodes: [...current.nodes, { ...node, title: image.fileName, image, worldbookEntryIds: [entryId] }] };
      });
    }} />
  </section>;
}
