import React, { useEffect, useState } from 'react';
import { api, type DiscoveredModel, type ProviderTestResult } from './api';
import { useI18n } from './i18n';
import { createWorldbookEntry, downloadText, parseDelimitedList } from './project';
import { parseWorldbookImport } from './projectOperations';
import { useProjectStore } from './projectStore';
import type {
  KnowledgeBaseMetadata, ModelRoutingSettings, PublicLocalAppConfig, RegisteredModel, WorldbookEntry,
} from './types';

function PageHeader({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: React.ReactNode }) {
  return <header className="page-heading"><div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2><p>{description}</p></div>{actions ? <div className="page-actions">{actions}</div> : null}</header>;
}

export function MemoryPage() {
  const { t } = useI18n();
  const { project } = useProjectStore();
  const [metadata, setMetadata] = useState<KnowledgeBaseMetadata | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!project) return;
    let canceled = false;
    setBusy(true);
    api.getMemory(project).then((value) => { if (!canceled) setMetadata(value); }).catch((error: unknown) => { if (!canceled) setStatus(error instanceof Error ? error.message : t('unavailable')); }).finally(() => { if (!canceled) setBusy(false); });
    return () => { canceled = true; };
  }, [project?.createdAt, t]);

  if (!project) return null;
  const reindex = async () => {
    setBusy(true); setStatus(t('loading'));
    try {
      const result = await api.reindexMemory(project);
      setMetadata(await api.getMemory(project));
      setStatus(result.unavailableReason ?? `${result.indexedChunks} chunks indexed.`);
    } catch (error) { setStatus(error instanceof Error ? error.message : t('unavailable')); }
    finally { setBusy(false); }
  };
  return <main className="page-content">
    <PageHeader eyebrow={t('memory')} title={t('memoryTitle')} description={t('memoryDescription')} actions={<button type="button" disabled={busy} onClick={() => void reindex()}>{t('rebuildMemory')}</button>} />
    <div className="info-callout">{t('noPaidAuto')}</div>
    {metadata?.stale ? <div className="warning-callout">{t('staleMemory')}</div> : null}
    {status ? <div className="status-line" role="status">{status}</div> : null}
    <section className="metric-grid">
      <article><span>{t('indexedSources')}</span><strong>{metadata?.documents.length ?? 0}</strong></article>
      <article><span>{t('embeddingModel')}</span><strong>{metadata?.embeddingModelId ?? t('unavailable')}</strong></article>
      <article><span>Updated</span><strong>{metadata?.updatedAt ? new Date(metadata.updatedAt).toLocaleString() : '—'}</strong></article>
    </section>
    <section className="card-list">{metadata?.documents.map((document) => <article key={document.id} className="content-card"><div><strong>{document.title}</strong><span>{document.tags.join(' · ')}</span></div><span>{document.chunkIds.length} chunks</span></article>)}</section>
  </main>;
}

export function WorldbookPage() {
  const { t } = useI18n();
  const { project, updateProject } = useProjectStore();
  const [search, setSearch] = useState('');
  const [enabledOnly, setEnabledOnly] = useState(false);
  const [status, setStatus] = useState('');
  if (!project) return null;
  const entries = project.worldbook.entries.filter((entry) => {
    const needle = search.toLowerCase();
    return (!enabledOnly || entry.enabled) && (!needle || `${entry.title} ${entry.content} ${entry.keys.join(' ')} ${entry.tags.join(' ')}`.toLowerCase().includes(needle));
  });
  const updateEntry = (id: string, changes: Partial<WorldbookEntry>) => updateProject((current) => ({ ...current, worldbook: { entries: current.worldbook.entries.map((entry) => entry.id === id ? { ...entry, ...changes } : entry) } }));
  const importWorldbook = async (file: File | null) => {
    if (!file) return;
    try {
      const imported = parseWorldbookImport(JSON.parse(await file.text()) as unknown);
      if (project.worldbook.entries.length && !window.confirm(t('confirmReplaceWorldbook'))) return;
      updateProject((current) => ({ ...current, worldbook: { entries: imported } }));
      setStatus(`${imported.length} entries imported.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Invalid Worldbook JSON');
    }
  };
  return <main className="page-content">
    <PageHeader eyebrow={t('worldbook')} title={t('worldbook')} description={t('worldbookDescription')} actions={<>
      <button type="button" onClick={() => updateProject((current) => ({ ...current, worldbook: { entries: [createWorldbookEntry(), ...current.worldbook.entries] } }))}>{t('addEntry')}</button>
      <button type="button" className="secondary" onClick={() => downloadText(`${project.title}-worldbook.json`, JSON.stringify(project.worldbook, null, 2), 'application/json')}>{t('exportWorldbook')}</button>
      <label className="button-like secondary">{t('importWorldbook')}<input type="file" accept=".json,application/json" onChange={(event) => { void importWorldbook(event.target.files?.[0] ?? null); event.target.value = ''; }} /></label>
    </>} />
    <div className="filter-bar"><input aria-label={t('searchNodes')} placeholder={t('searchNodes')} value={search} onChange={(event) => setSearch(event.target.value)} /><label className="inline-check"><input type="checkbox" checked={enabledOnly} onChange={(event) => setEnabledOnly(event.target.checked)} />{t('enabled')}</label><span>{entries.length} / {project.worldbook.entries.length}</span></div>
    {status ? <div className="status-line" role="status">{status}</div> : null}
    <section className="accordion-list">{entries.map((entry) => <details key={entry.id} className="accordion-card"><summary><span className={entry.enabled ? 'status-dot success' : 'status-dot'} /><strong>{entry.title || 'Untitled'}</strong><span>{entry.keys.length} {t('keys')}</span><span>{entry.tags.join(' · ')}</span></summary><div className="accordion-body">
      <div className="form-grid two"><label className="inline-check"><input type="checkbox" checked={entry.enabled} onChange={(event) => updateEntry(entry.id, { enabled: event.target.checked })} />{t('enabled')}</label><label className="inline-check"><input type="checkbox" checked={entry.alwaysOn} onChange={(event) => updateEntry(entry.id, { alwaysOn: event.target.checked })} />{t('alwaysOn')}</label></div>
      <label>{t('title')}<input value={entry.title} onChange={(event) => updateEntry(entry.id, { title: event.target.value })} /></label>
      <div className="form-grid two"><label>{t('keys')}<input value={entry.keys.join(', ')} onChange={(event) => updateEntry(entry.id, { keys: parseDelimitedList(event.target.value) })} /></label><label>{t('tags')}<input value={entry.tags.join(', ')} onChange={(event) => updateEntry(entry.id, { tags: parseDelimitedList(event.target.value) })} /></label></div>
      <div className="form-grid three"><label>{t('priority')}<input type="number" value={entry.priority} onChange={(event) => updateEntry(entry.id, { priority: Number(event.target.value) })} /></label><label>{t('tokenBudget')}<input type="number" min="0" value={entry.tokenBudget ?? ''} onChange={(event) => updateEntry(entry.id, { tokenBudget: event.target.value ? Number(event.target.value) : null })} /></label><label>{t('insertion')}<select value={entry.insertionPosition} onChange={(event) => updateEntry(entry.id, { insertionPosition: event.target.value as WorldbookEntry['insertionPosition'] })}><option value="before_context">before context</option><option value="after_context">after context</option></select></label></div>
      <label>{t('content')}<textarea rows={10} value={entry.content} onChange={(event) => updateEntry(entry.id, { content: event.target.value })} /></label>
      <button type="button" className="danger" onClick={() => updateProject((current) => ({ ...current, worldbook: { entries: current.worldbook.entries.filter((item) => item.id !== entry.id) } }))}>{t('deleteNode')}</button>
    </div></details>)}</section>
  </main>;
}

export function ExportPage() {
  const { t } = useI18n();
  const { project, updateProject } = useProjectStore();
  const [selected, setSelected] = useState<string[]>([]);
  const [status, setStatus] = useState('');
  if (!project) return null;
  const mode = project.settings.defaultExportMode;
  const exportText = async () => {
    try {
      setStatus(t('loading'));
      const text = await api.exportTxt(project, selected, mode);
      downloadText(`${project.title}-${mode}.txt`, text, 'text/plain;charset=utf-8');
      setStatus(t('saved'));
    } catch (error) { setStatus(error instanceof Error ? error.message : t('unavailable')); }
  };
  return <main className="page-content">
    <PageHeader eyebrow={t('export')} title={t('exportTitle')} description={t('exportHint')} actions={<button type="button" onClick={() => void exportText()}>{t('exportTxt')}</button>} />
    <section className="form-card"><div className="form-grid two"><label>{t('exportMode')}<select value={mode} onChange={(event) => updateProject((current) => ({ ...current, settings: { ...current.settings, defaultExportMode: event.target.value as 'assets' | 'manuscript' } }))}><option value="assets">{t('assets')}</option><option value="manuscript">{t('manuscript')}</option></select></label><div className="button-row align-end"><button type="button" className="secondary" onClick={() => setSelected(project.nodes.map((node) => node.id))}>{t('selectAll')}</button><button type="button" className="secondary" onClick={() => setSelected([])}>{t('clear')}</button></div></div>{status ? <p className="status-line">{status}</p> : null}</section>
    <section className="selection-grid">{project.nodes.map((node) => <label key={node.id} className="selection-card"><input type="checkbox" checked={selected.includes(node.id)} onChange={() => setSelected((current) => current.includes(node.id) ? current.filter((id) => id !== node.id) : [...current, node.id])} /><span><strong>{node.title}</strong><small>{node.type} · {node.metadata.tags.join(', ')}</small></span></label>)}</section>
  </main>;
}

const routeLabels: Array<{ key: keyof ModelRoutingSettings; label: 'structure' | 'paragraph' | 'compression' | 'embedding' }> = [
  { key: 'structureDerivationModelId', label: 'structure' }, { key: 'paragraphGenerationModelId', label: 'paragraph' },
 { key: 'contextCompressionModelId', label: 'compression' },
  { key: 'embeddingModelId', label: 'embedding' },
];

export function SettingsPage() {
  const { t } = useI18n();
  const { project, updateProject } = useProjectStore();
  const [config, setConfig] = useState<PublicLocalAppConfig>({ providers: [], registeredModels: [] });
  const [providerId, setProviderId] = useState('siliconflow'); const [providerName, setProviderName] = useState('SiliconFlow');
  const [baseUrl, setBaseUrl] = useState('https://api.siliconflow.cn/v1'); const [apiKey, setApiKey] = useState('');
  const [headersJson, setHeadersJson] = useState(''); const [clearKey, setClearKey] = useState(false);
  const [selectedProviderId, setSelectedProviderId] = useState(''); const [models, setModels] = useState<DiscoveredModel[]>([]);
  const [selectedModelId, setSelectedModelId] = useState('');
  const [capabilities, setCapabilities] = useState<RegisteredModel['capabilityTags']>(['text']);
  const [contextWindow, setContextWindow] = useState(''); const [embeddingDimensions, setEmbeddingDimensions] = useState('');
  const [result, setResult] = useState<ProviderTestResult | null>(null); const [status, setStatus] = useState('');
  const [chatModelBusy, setChatModelBusy] = useState(false);

  useEffect(() => { void api.getAppConfig().then((value) => { setConfig(value); setSelectedProviderId(value.providers[0]?.id ?? ''); }).catch((error: unknown) => setStatus(error instanceof Error ? error.message : t('unavailable'))); }, [t]);
  if (!project) return null;
  const saveProvider = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const headers = headersJson.trim() ? JSON.parse(headersJson) as Record<string, string> : {};
      if (!headers || Array.isArray(headers) || typeof headers !== 'object') throw new Error(t('invalidHeaders'));
      const next = await api.registerProvider({ id: providerId.trim(), name: providerName.trim(), baseUrl: baseUrl.trim(), apiKey: apiKey || null, clearApiKey: clearKey, headers });
      setConfig(next); setSelectedProviderId(providerId.trim()); setApiKey(''); setClearKey(false); setStatus(t('saved'));
    } catch (error) { setStatus(error instanceof Error ? error.message : t('unavailable')); }
  };
  const discover = async () => { try { const response = await api.listProviderModels(selectedProviderId); setModels(response.models); setSelectedModelId(response.models[0]?.id ?? ''); } catch (error) { setStatus(error instanceof Error ? error.message : t('unavailable')); } };
  const test = async () => { try { setResult(await api.testProvider(selectedProviderId, capabilities.some((tag) => tag !== 'embedding') ? selectedModelId || undefined : undefined, capabilities.includes('embedding') ? selectedModelId || undefined : undefined)); } catch (error) { setStatus(error instanceof Error ? error.message : t('unavailable')); } };
  const register = async () => { try { setConfig(await api.registerModel({ providerId: selectedProviderId, modelId: selectedModelId, displayName: selectedModelId, capabilityTags: capabilities, contextWindowTokens: contextWindow ? Number(contextWindow) : null, embeddingDimensions: embeddingDimensions ? Number(embeddingDimensions) : null })); setStatus(t('saved')); } catch (error) { setStatus(error instanceof Error ? error.message : t('unavailable')); } };
  const updateRoute = (key: keyof ModelRoutingSettings, value: string) => updateProject((current) => ({ ...current, settings: { ...current.settings, modelRouting: { ...current.settings.modelRouting, [key]: value || null } } }));
  const saveChatModel = async (id: string) => { setChatModelBusy(true); try { setConfig(await api.setChatModel(id || null)); setStatus(t('saved')); } catch (e) { setStatus(e instanceof Error ? e.message : String(e)); } finally { setChatModelBusy(false); } };
  return <main className="page-content">
    <PageHeader eyebrow={t('settings')} title={t('settings')} description={t('keepKeyHint')} />
    <section className="form-card"><label>{t('chatModel')}<select disabled={chatModelBusy} value={config.chatModelId ?? ''} onChange={(e) => void saveChatModel(e.target.value)}><option value="">—</option>{config.registeredModels.filter((model) => model.enabled && model.capabilityTags.some((tag) => tag !== 'embedding')).map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}</select></label><p className="helper-text">{t('chatModelHint')}</p></section>
    {status ? <div className="status-line">{status}</div> : null}
    <section className="settings-grid"><form className="form-card" onSubmit={(event) => void saveProvider(event)}><div className="card-heading"><span className="card-icon">⌁</span><div><h3>{t('provider')}</h3><p>{t('keepKeyHint')}</p></div></div>
      <div className="form-grid two"><label>{t('providerId')}<input required value={providerId} onChange={(event) => setProviderId(event.target.value)} /></label><label>{t('providerName')}<input required value={providerName} onChange={(event) => setProviderName(event.target.value)} /></label></div>
      <label>{t('apiRoot')}<input required value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} /></label><label>{t('apiKey')}<input type="password" value={apiKey} disabled={clearKey} onChange={(event) => setApiKey(event.target.value)} /><small>{t('keepKeyHint')}</small></label><label className="inline-check"><input type="checkbox" checked={clearKey} onChange={(event) => setClearKey(event.target.checked)} />{t('clearSavedKey')}</label><label>{t('customHeaders')}<textarea rows={4} value={headersJson} onChange={(event) => setHeadersJson(event.target.value)} /></label><button type="submit">{t('saveProvider')}</button>
    </form>
    <section className="form-card"><div className="card-heading"><span className="card-icon">◎</span><div><h3>{t('models')}</h3><p>{t('capabilities')}</p></div></div><label>{t('provider')}<select value={selectedProviderId} onChange={(event) => { setSelectedProviderId(event.target.value); setModels([]); setSelectedModelId(''); setResult(null); }}><option value="">—</option>{config.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label><div className="button-row"><button type="button" disabled={!selectedProviderId} onClick={() => void discover()}>{t('discoverModels')}</button><button type="button" className="secondary" disabled={!selectedProviderId} onClick={() => void test()}>{t('testProvider')}</button></div><label>{t('discoveredModel')}<select value={selectedModelId} onChange={(event) => setSelectedModelId(event.target.value)}><option value="">—</option>{models.map((model) => <option key={model.id} value={model.id}>{model.id}</option>)}</select></label><div className="chip-checks">{(['text', 'structure', 'compression', 'embedding', 'vision'] as const).map((capability) => <label key={capability}><input type="checkbox" checked={capabilities.includes(capability)} onChange={() => setCapabilities((current) => current.includes(capability) ? current.filter((item) => item !== capability) : [...current, capability])} />{capability}</label>)}</div><div className="form-grid two"><label>{t('contextWindow')}<input type="number" min="0" value={contextWindow} onChange={(event) => setContextWindow(event.target.value)} /></label><label>{t('embeddingDimensions')}<input type="number" min="0" value={embeddingDimensions} onChange={(event) => setEmbeddingDimensions(event.target.value)} /></label></div><button type="button" disabled={!selectedProviderId || !selectedModelId} onClick={() => void register()}>{t('registerModel')}</button>{result ? <div className="result-box"><span>List: {String(result.modelListingOk)}</span><span>Chat: {String(result.chatCompletionOk ?? '—')}</span><span>Embedding: {String(result.embeddingOk ?? '—')}</span>{result.errors.map((error) => <span className="error-text" key={error}>{error}</span>)}</div> : null}</section></section>
    <section className="form-card"><div className="card-heading"><span className="card-icon">⇄</span><div><h3>{t('modelRouting')}</h3><p>{t('projectLanguage')}</p></div></div><div className="form-grid three"><label>{t('projectLanguage')}<select value={project.settings.defaultLanguage} onChange={(event) => updateProject((current) => ({ ...current, settings: { ...current.settings, defaultLanguage: event.target.value } }))}><option value="zh-CN">简体中文</option><option value="en">English</option></select></label>{routeLabels.map((route) => <label key={route.key}>{t(route.label)}<select value={project.settings.modelRouting[route.key] ?? ''} onChange={(event) => updateRoute(route.key, event.target.value)}><option value="">—</option>{config.registeredModels.filter((model) => model.enabled && (route.key !== 'embeddingModelId' || model.capabilityTags.includes('embedding'))).map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}</select></label>)}</div></section>
    <section className="form-card"><h3>{t('registeredModels')}</h3><div className="card-list">{config.registeredModels.map((model) => <article key={model.id} className="content-card"><div><strong>{model.displayName}</strong><span>{model.modelId}</span></div><span>{model.capabilityTags.join(' · ')}</span></article>)}</div></section>
  </main>;
}

export function PromptsPage() {
  const { t } = useI18n();
  const { project, updateProject } = useProjectStore();
  const [config, setConfig] = useState<PublicLocalAppConfig>({ providers: [], registeredModels: [] });
  const [routeKey, setRouteKey] = useState<keyof ModelRoutingSettings>('structureDerivationModelId');
  useEffect(() => { void api.getAppConfig().then(setConfig); }, []);
  if (!project) return null;
  const modelId = project.settings.modelRouting[routeKey] ?? '';
  const model = config.registeredModels.find((item) => item.id === modelId);
  const value = modelId ? project.settings.modelGlobalPrompts[routeKey]?.[modelId] ?? '' : '';
  return <main className="page-content"><PageHeader eyebrow={t('prompts')} title={t('promptEditor')} description={t('promptHint')} /><section className="prompt-layout"><nav className="route-tabs">{routeLabels.filter((route) => route.key !== 'embeddingModelId').map((route) => <button type="button" className={routeKey === route.key ? 'active' : ''} key={route.key} onClick={() => setRouteKey(route.key)}>{t(route.label)}</button>)}</nav><section className="form-card"><div className="card-heading"><span className="card-icon">✦</span><div><h3>{model?.displayName ?? t('noModel')}</h3><p>{modelId || '—'}</p></div></div><label>{t('globalPrompt')}<textarea rows={22} disabled={!modelId} value={value} onChange={(event) => updateProject((current) => ({ ...current, settings: { ...current.settings, modelGlobalPrompts: { ...current.settings.modelGlobalPrompts, [routeKey]: { ...(current.settings.modelGlobalPrompts[routeKey] ?? {}), [modelId]: event.target.value } } } }))} /></label></section></section></main>;
}
