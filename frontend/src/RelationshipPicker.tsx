import { useState } from 'react';
import { useI18n } from './i18n';
import { useProjectStore } from './projectStore';
import { addRelationship, relationshipLabels } from './relationships';
import { newEdgeSemantics as edgeSemantics } from './project';
import type { EdgeSemantic } from './types';

export function RelationshipPicker({ targetId, sourceId, onClose }: { targetId: string; sourceId?: string; onClose?: () => void }) {
  const { locale } = useI18n(); const zh = locale === 'zh-CN';
  const { project, updateProject } = useProjectStore();
  const [search, setSearch] = useState('');
  const [source, setSource] = useState(sourceId ?? '');
  const [semantic, setSemantic] = useState<EdgeSemantic>('reference');
  const [error, setError] = useState('');
  if (!project) return null;
  const target = project.nodes.find((node) => node.id === targetId);
  const candidates = project.nodes.filter((node) => node.id !== targetId && `${node.title} ${node.type}`.toLowerCase().includes(search.toLowerCase()));
  const selected = project.nodes.find((node) => node.id === source);
  return <section className="relationship-picker" aria-label={zh ? '添加关联' : 'Add relationship'}>
    <strong>{zh ? '给当前节点添加关联' : 'Add a source for this node'}</strong>
    <p>{selected?.title ?? (zh ? '选择来源' : 'Choose source')} → {target?.title}</p>
    {!sourceId && <><input aria-label={zh ? '搜索关联节点' : 'Search reference nodes'} placeholder={zh ? '搜索节点名称' : 'Search nodes'} value={search} onChange={(event) => setSearch(event.target.value)} />
      <select aria-label={zh ? '来源节点' : 'Source node'} value={source} onChange={(event) => setSource(event.target.value)}><option value="">{zh ? '选择来源节点' : 'Choose source'}</option>{selected && !candidates.includes(selected) && <option value={selected.id}>{selected.title}</option>}{candidates.slice(0, 100).map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}</select><small>{zh ? '最多显示 100 条，可搜索缩小范围。' : 'Up to 100 matches; search to narrow.'}</small></>}
    <label>{zh ? '关系用途' : 'Relationship'}<select value={semantic} onChange={(event) => setSemantic(event.target.value as EdgeSemantic)}>{edgeSemantics.map((key) => <option key={key} value={key}>{relationshipLabels[key][zh ? 0 : 1]}</option>)}</select></label>
    <p className="helper-text">{relationshipLabels[semantic][zh ? 2 : 3]}</p>
    <div className="button-row"><button disabled={!source} onClick={() => { try { const next = addRelationship(project, source, targetId, semantic); updateProject(() => next); setError(''); onClose?.(); if (!sourceId) setSource(''); } catch (e) { setError(String(e)); } }}>{zh ? '建立关联' : 'Connect'}</button>{onClose && <button className="secondary" onClick={onClose}>{zh ? '取消' : 'Cancel'}</button>}</div>
    {error && <p role="alert">{error}</p>}
  </section>;
}
