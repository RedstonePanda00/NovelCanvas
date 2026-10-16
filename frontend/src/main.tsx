import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { api } from './api';
import { CanvasWorkspace } from './CanvasWorkspace';
import { I18nProvider, useI18n } from './i18n';
import { createEmptyProject, downloadText } from './project';
import { ProjectStoreProvider, useProjectStore } from './projectStore';
import { ExportPage, MemoryPage, PromptsPage, SettingsPage, WorldbookPage } from './pages';
import './styles.css';
import './chat.css';

type View = 'canvas' | 'memory' | 'worldbook' | 'prompts' | 'export' | 'settings';

function App() {
  const { t, locale, setLocale } = useI18n();
  const { project, session, openProject, updateProject, saveNow, saveStatus, saveMessage } = useProjectStore();
  const [activeView, setActiveView] = useState<View>('canvas');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [mobileNav, setMobileNav] = useState(false);

  const loadProject = async () => {
    setLoading(true); setLoadError('');
    try { openProject(await api.getProject()); }
    catch (error) { setLoadError(error instanceof Error ? error.message : t('failedToLoad')); }
    finally { setLoading(false); }
  };

  useEffect(() => { void loadProject(); }, []);

  const importProject = async (file: File | null) => {
    if (!file || (project && !window.confirm(t('confirmReplaceProject')))) return;
    try {
      if (project) await saveNow();
      const payload = JSON.parse(await file.text()) as unknown;
      openProject(await api.importProject(payload));
      setActiveView('canvas');
    } catch (error) { setLoadError(error instanceof Error ? error.message : t('failedToLoad')); }
  };

  const newProject = async () => {
    if (project && !window.confirm(t('confirmReplaceProject'))) return;
    const title = window.prompt(t('title'), 'Untitled Novel Canvas Project');
    if (title === null) return;
    const draft = createEmptyProject(title.trim() || 'Untitled Novel Canvas Project');
    try {
      if (project) await saveNow();
      openProject(await api.saveProject(draft));
      setActiveView('canvas');
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t('saveFailed'));
    }
  };

  const backup = () => {
    if (!project) return;
    const safeTitle = (project.title || 'novel-canvas').replace(/[\\/:*?"<>|]+/g, '-');
    downloadText(`${safeTitle}.json`, JSON.stringify(project, null, 2), 'application/json;charset=utf-8');
  };

  const nav: Array<{ id: View; label: string; icon: string }> = [
    { id: 'canvas', label: t('canvas'), icon: '◇' }, { id: 'memory', label: t('memory'), icon: '◉' },
    { id: 'worldbook', label: t('worldbook'), icon: '▤' }, { id: 'prompts', label: t('prompts'), icon: '✦' },
    { id: 'export', label: t('export'), icon: '⇩' }, { id: 'settings', label: t('settings'), icon: '⚙' },
  ];

  const saveLabel = saveStatus === 'saving' ? t('saving') : saveStatus === 'dirty' ? t('dirty') : saveStatus === 'error' ? t('saveFailed') : t('saved');

  return <div className="app-frame">
    <header className="app-bar">
      <button className="mobile-nav-toggle" type="button" aria-label={t('mobileMenu')} onClick={() => setMobileNav((value) => !value)}>☰</button>
      <div className="brand-mark">N</div><div className="brand-copy"><strong>{t('appName')}</strong><span>{project?.title ?? t('loading')}</span></div>
      <div className="app-bar-spacer" />
      <button type="button" className={`save-indicator state-${saveStatus}`} onClick={() => void saveNow()} title={saveMessage || t('saveNow')}><span />{saveLabel}</button>
      <button type="button" className="locale-switch" onClick={() => setLocale(locale === 'en' ? 'zh-CN' : 'en')}>{locale === 'en' ? '中文' : 'EN'}</button>
      <details className="project-menu"><summary aria-label={t('projectMenu')}>{t('project')} ▾</summary><div className="menu-popover">
        {project ? <label>{t('title')}<input value={project.title} onChange={(event) => updateProject((current) => ({ ...current, title: event.target.value }))} /></label> : null}
        <button type="button" onClick={() => void saveNow()}>{t('saveNow')}<span>Ctrl/⌘ S</span></button>
        <button type="button" onClick={backup}>{t('backupProject')}<span>JSON</span></button>
        <label className="menu-file-button">{t('loadProject')}<input type="file" accept=".json,application/json" onChange={(event) => { void importProject(event.target.files?.[0] ?? null); event.target.value = ''; }} /></label>
        <button type="button" onClick={() => void newProject()}>{t('newProject')}</button>
        <small>{t('saveBeforeClose')}</small>
      </div></details>
    </header>
    <aside className={`primary-nav ${mobileNav ? 'open' : ''}`}><nav>{nav.map((item) => <button type="button" key={item.id} className={activeView === item.id ? 'active' : ''} onClick={() => { setActiveView(item.id); setMobileNav(false); }}><span>{item.icon}</span><strong>{item.label}</strong></button>)}</nav><div className="nav-footer"><span>LOCAL</span><small>v0.2 workspace</small></div></aside>
    <div className="app-main">
      {loading ? <div className="startup-state"><div className="brand-mark large">N</div><h1>{t('appName')}</h1><p>{t('loading')}</p></div> : loadError && !project ? <div className="startup-state"><h1>{t('failedToLoad')}</h1><p>{loadError}</p><button type="button" onClick={() => void loadProject()}>{t('retry')}</button></div> : <>
        {loadError ? <div className="warning-callout" role="alert">{loadError}</div> : null}
        <div hidden={activeView !== 'canvas'}><CanvasWorkspace key={session} active={activeView === 'canvas'} /></div>
        {activeView === 'memory' ? <MemoryPage /> : null}
        {activeView === 'worldbook' ? <WorldbookPage /> : null}
        {activeView === 'prompts' ? <PromptsPage /> : null}
        {activeView === 'export' ? <ExportPage /> : null}
        {activeView === 'settings' ? <SettingsPage /> : null}
      </>}
    </div>
    {mobileNav ? <button className="nav-scrim" type="button" aria-label={t('close')} onClick={() => setMobileNav(false)} /> : null}
    <div className="global-live-region" aria-live="polite">{saveMessage}</div>
  </div>;
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<React.StrictMode><I18nProvider><ProjectStoreProvider><App /></ProjectStoreProvider></I18nProvider></React.StrictMode>);
