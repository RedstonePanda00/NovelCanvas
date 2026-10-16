import { useState } from 'react';
import type { NodeWorkbench } from './types';

export function ChatIcon({ name }: { name: 'sidebar' | 'chat' | 'plus' | 'close' | 'send' | 'attach' | 'delete' | 'chevron' }) {
  const paths = {
    sidebar: 'M4 4h16v16H4z M10 4v16', chat: 'M4 4h16v12H9l-5 4z',
    plus: 'M12 5v14 M5 12h14', close: 'M6 6l12 12 M18 6L6 18',
    send: 'M12 19V5 M6 11l6-6 6 6', attach: 'M9 13l6-6a3 3 0 014 4l-9 9a5 5 0 01-7-7l10-10',
    delete: 'M4 6h16 M9 6V3h6v3 M6 6l1 15h10l1-15 M10 10v7 M14 10v7',
    chevron: 'M9 5l7 7-7 7',
  };
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

export function conversationTitle(work: NodeWorkbench | undefined, index: number, zh: boolean) {
  return work?.title || (zh ? `新对话 ${index + 1}` : `New conversation ${index + 1}`);
}

export function ChatNavigation({ ids, workbench, activeId, zh, onSelect, onCreate, onCollapse }: {
  ids: string[]; workbench: Record<string, NodeWorkbench>; activeId: string; zh: boolean;
  onSelect: (id: string) => void; onCreate: () => void; onCollapse: () => void;
}) {
  const [query, setQuery] = useState('');
  const now = Date.now();
  const groups = [zh ? '最近 30 天' : 'Last 30 days', zh ? '更早' : 'Older'];
  const rows = ids.map((id, index) => {
    const work = workbench[id];
    const lastMessage = work?.messages[work.messages.length - 1];
    const timestamp = Date.parse(lastMessage?.createdAt ?? '') || now;
    return { id, title: conversationTitle(work, index, zh), work, timestamp };
  }).filter(({ title, work }) => `${title} ${work?.draft ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => b.timestamp - a.timestamp);
  return <nav className="chat-conversations" aria-label={zh ? '会话列表' : 'Conversations'}>
    <header><span>{zh ? '对话' : 'Conversations'}</span><button className="chat-icon-button" aria-label={zh ? '折叠会话列表' : 'Collapse conversations'} title={zh ? '折叠会话列表' : 'Collapse conversations'} onClick={onCollapse}><ChatIcon name="sidebar" /></button></header>
    <input type="search" aria-label={zh ? '搜索对话' : 'Search conversations'} placeholder={zh ? '搜索对话…' : 'Search conversations…'} value={query} onChange={(event) => setQuery(event.target.value)} />
    <button className="chat-new-conversation" aria-label={zh ? '新建对话' : 'New conversation'} onClick={() => { setQuery(''); onCreate(); }}><ChatIcon name="plus" />{zh ? '新建对话' : 'New conversation'}</button>
    <div className="chat-conversation-scroll">
      {groups.map((group, groupIndex) => {
        const matches = rows.filter((row) => (now - row.timestamp > 30 * 86400000 ? 1 : 0) === groupIndex);
        return matches.length > 0 && <section key={group}><h3>{group}</h3>{matches.map(({ id, title, work }) => <button key={id} data-conversation-id={id} aria-current={id === activeId ? 'page' : undefined} className={`chat-conversation-item ${id === activeId ? 'active' : ''}`} onClick={() => onSelect(id)} title={title}>
          <span className={`conversation-status ${work?.agentRun?.status ?? 'idle'}`} aria-label={work?.agentRun?.status === 'running' ? (zh ? '执行中' : 'Running') : undefined} /><span>{title}</span>
        </button>)}</section>;
      })}
      {!rows.length && <p className="chat-empty-search">{zh ? '没有匹配的对话' : 'No matching conversations'}</p>}
    </div>
    <footer>{zh ? '当前小说的对话' : 'Conversations in this novel'}</footer>
  </nav>;
}
