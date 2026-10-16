import { useEffect, useRef, useState } from 'react';
import { api, type AssistantPreview } from './api';
import { useI18n } from './i18n';
import { useProjectStore } from './projectStore';
import { nowIso } from './project';
import { acceptVersion, addVersion, applyAgentVersions, CHAT_WORKBENCH, deleteConversation, emptyWorkbench, isConversationId, rollbackVersion, updateWorkbench } from './workbench';
import { WorkbenchDialog } from './WorkbenchDialog';
import { ChatBlockCard } from './ChatBlockCard';
import { ChatIcon, ChatNavigation, conversationTitle } from './ChatNavigation';
import { agentDrafts } from './agentConversation';
import { agentActivityKey, agentToolLabel } from './agentLabels';
import { mergeAgentCheckpoint } from './agentCheckpoint';
import { applyAgentTransaction, rollbackAgentTransaction } from './agentTransaction';
import type { AgentMutation, AssistantContext, CanvasNode, DraftVersion } from './types';

export const CHAT_NODE_MIME = 'application/x-novel-chat-node';
type VersionSelection = { owner: string; id: string };
type PanelProps = { node: CanvasNode | null; generationBusy?: boolean; expanded: boolean; onToggle: () => void; conversationsOpen: boolean; onToggleConversations: () => void };

export function AssistantPanel(props: PanelProps) {
  const { project, updateProject } = useProjectStore();
  const { locale } = useI18n(); const zh = locale === 'zh-CN';
  const ids = Object.keys(project?.workbench ?? {}).filter(isConversationId);
  if (!ids.length) ids.push(CHAT_WORKBENCH);
  const activeId = ids.includes(project?.activeChatId ?? '') ? project!.activeChatId! : ids[0];
  const [visited, setVisited] = useState<string[]>([activeId]);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [epochs, setEpochs] = useState<Record<string, number>>({});
  const [modelName, setModelName] = useState('');
  useEffect(() => { setVisited((current) => current.includes(activeId) ? current : [...current, activeId]); }, [activeId]);
  useEffect(() => {
    if (!props.expanded) return;
    let alive = true;
    void api.getAppConfig().then((config) => { if (alive) setModelName(config.registeredModels.find((model) => model.id === config.chatModelId)?.displayName ?? ''); }).catch(() => undefined);
    return () => { alive = false; };
  }, [props.expanded]);
  if (!project) return null;
  const createConversation = () => {
    const id = `${CHAT_WORKBENCH}:${crypto.randomUUID()}`;
    updateProject((current) => ({ ...updateWorkbench(current, id, () => emptyWorkbench()), activeChatId: id }), false);
    if (window.innerWidth <= 1100 && props.conversationsOpen) props.onToggleConversations();
    if (!props.expanded) props.onToggle();
  };
  return <div className="chat-session-shell">
    <div className="conversation-list-pane" hidden={!props.conversationsOpen}><ChatNavigation ids={ids} workbench={project.workbench ?? {}} activeId={activeId} zh={zh} onSelect={(id) => {
      updateProject((current) => ({ ...current, activeChatId: id }), false);
      if (window.innerWidth <= 1100 && props.conversationsOpen) props.onToggleConversations();
      if (!props.expanded) props.onToggle();
    }} onCreate={createConversation} onCollapse={props.onToggleConversations} /></div>
    {[...new Set([...visited, activeId])].filter((id) => ids.includes(id)).map((id) => <div className="conversation-pane" key={`${id}:${epochs[id] ?? 0}`} hidden={id !== activeId}>
      <ChatConversation {...props} ownerId={id} active={id === activeId} title={conversationTitle(project.workbench?.[id], ids.indexOf(id), zh)} modelName={modelName} onCreate={createConversation} onDelete={() => setDeleteId(id)} />
    </div>)}
    {deleteId && <WorkbenchDialog className="delete-dialog" label={zh ? '删除对话' : 'Delete conversation'} onClose={() => setDeleteId(null)}>
      <h2>{zh ? '删除此对话？' : 'Delete this conversation?'}</h2>
      <p>{project.workbench?.[deleteId]?.title || (zh ? '未命名对话' : 'Untitled conversation')}</p>
      <p>{zh ? '将删除此对话的记录、报告、草稿和修改历史，并停止进行中的请求。已写入作品的内容不会撤销。' : 'Deletes this conversation, reports, draft and change history, and stops its request. Manuscript edits are not reverted.'}</p>
      <div className="button-row"><button className="secondary" onClick={() => setDeleteId(null)}>{zh ? '取消' : 'Cancel'}</button><button className="danger" onClick={() => {
        const id = deleteId;
        updateProject((current) => deleteConversation(current, id));
        setEpochs((current) => ({ ...current, [id]: (current[id] ?? 0) + 1 })); setDeleteId(null);
      }}>{zh ? '确认删除' : 'Confirm delete'}</button></div>
    </WorkbenchDialog>}
  </div>;
}

function ChatConversation({ node, generationBusy = false, expanded, onToggle, conversationsOpen, onToggleConversations, ownerId, active, title, modelName, onCreate, onDelete }: PanelProps & { ownerId: string; active: boolean; title: string; modelName: string; onCreate: () => void; onDelete: () => void }) {
  const { locale } = useI18n(); const zh = locale === 'zh-CN';
  const { project, updateProject } = useProjectStore();
  const state = project?.workbench?.[ownerId] ?? emptyWorkbench();
  const targets = state.targetNodeIds ?? [];
  const references = state.referenceNodeIds ?? [];
  const input = state.draft ?? '';
  const setInput = (value: string | ((current: string) => string)) => updateProject((current) => !current.workbench?.[ownerId] && typeof value === 'function' ? current : updateWorkbench(current, ownerId, (work) => ({ ...work, draft: typeof value === 'function' ? value(work.draft ?? '') : value })), false);
  const [context, setContext] = useState<AssistantContext | null>(null);
  const [error, setError] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState('');
  const [live, setLive] = useState<AssistantPreview | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [compare, setCompare] = useState<VersionSelection | null>(null);
  const [base, setBase] = useState<VersionSelection | null>(null);
  const [historyEnabled, setHistoryEnabled] = useState(true);
  const scope = state.scope ?? 'project';
  const savedRun = state.agentRun;
  const abortRef = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const logRef = useRef<HTMLDivElement | null>(null);
  const followTail = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; abortRef.current?.abort(); }; }, []);
  useEffect(() => { if (logRef.current && followTail.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [state.messages.length, state.versions.length, savedRun?.activities, expanded, busy, live]);
  const baseVersion = base ? project?.workbench?.[base.owner]?.versions.find((item) => item.id === base.id) : undefined;
  const targetKey = targets.join('|'); const referenceKey = references.join('|');
  useEffect(() => {
    setContext(null); setPreviewError('');
    if (!project || !active) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void api.assistantContext({ project, targetNodeId: targets[0] ?? '', targetNodeIds: targets, referenceNodeIds: references, includeWorldbook: true, action: 'agent', message: input.trim() || ' ', baseText: baseVersion?.body, history: [] }, controller.signal)
        .then((value) => { if (!controller.signal.aborted) setContext(value); })
        .catch((e: unknown) => { if (!controller.signal.aborted) setPreviewError(e instanceof Error ? e.message : String(e)); });
    }, 350);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [project?.nodes, project?.edges, project?.worldbook, targetKey, referenceKey, input, baseVersion?.body, active]);
  if (!project) return null;
  const change = (updater: (current: typeof state) => typeof state) => updateProject((current) => updateWorkbench(current, ownerId, updater), false);
  const attach = (id: string) => {
    if (busy || !project.nodes.some((item) => item.id === id)) return;
    change((current) => ({ ...current, targetNodeIds: [...new Set([...(current.targetNodeIds ?? []), id])] }));
    if (!expanded) onToggle();
  };
  const mutations = state.mutations ?? [];
  const versions = state.versions.map((version) => ({ owner: ownerId, version }));
  const inspected = compare ? project.workbench?.[compare.owner]?.versions.find((item) => item.id === compare.id) : undefined;
  const allowedIds = new Set(context?.nodes.map((item) => item.id) ?? []);
  const deeperIds = [...new Set(project.edges.filter((edge) => allowedIds.has(edge.targetNodeId) && !allowedIds.has(edge.sourceNodeId)).map((edge) => edge.sourceNodeId))];
  const reviews = project.edges.filter((edge) => targets.includes(edge.sourceNodeId) && edge.semantic === 'review_target')
    .map((edge) => project.nodes.find((item) => item.id === edge.targetNodeId)).filter((item): item is CanvasNode => Boolean(item?.metadata.tags.includes('legacy-review') && item.body));

  const run = async (resume = false) => {
    if (resume && scope !== 'project') { setError(zh ? '请切回“整部作品”范围后继续此任务。' : 'Switch back to project scope to resume this task.'); return; }
    if (abortRef.current || busy || generationBusy || (!resume && !input.trim()) || (scope === 'attached' && (!context || previewError))) return;
    const previousRun = resume ? savedRun : undefined;
    const instruction = previousRun?.instruction ?? input.trim();
    const controller = new AbortController(); abortRef.current = controller;
    const runId = previousRun?.id ?? crypto.randomUUID();
    const runTargets = previousRun?.targetNodeIds ?? targets;
    const runReferences = previousRun?.referenceNodeIds ?? references;
    const runScope = previousRun ? 'project' : scope;
    followTail.current = true; setBusy(true); setSubmitted(instruction); setLive(null); setError('');
    const baseTarget = baseVersion?.status === 'accepted' ? baseVersion.appliedNodeId ?? baseVersion.targetNodeId ?? base?.owner : baseVersion?.targetNodeId ?? base?.owner;
    const requestMessage = previousRun?.requestMessage ?? (baseVersion ? `${instruction}\n\n${zh ? '继续修改以下候选；它不一定是当前正文。' : 'Continue revising this candidate; it may not be current text.'}\n${JSON.stringify({ targetNodeId: baseTarget, operation: baseVersion.status === 'accepted' ? 'replace' : baseVersion.operation, nodeType: baseVersion.nodeType, body: baseVersion.body })}` : instruction);
    let checkpoint = previousRun?.checkpoint;
    if (runScope === 'project') change((work) => ({ ...work, agentRun: { id: runId, instruction, requestMessage,
      targetNodeIds: runTargets, referenceNodeIds: runReferences, checkpoint: previousRun?.checkpoint,
      activities: previousRun?.activities ?? [], status: 'running' } }));
    try {
      const response = await api.streamAssistant({ project: { ...project, workbench: {} }, scope: runScope,
        checkpoint: previousRun?.checkpoint, targetNodeId: runTargets[0] ?? '', targetNodeIds: runTargets,
        referenceNodeIds: runReferences, includeWorldbook: true, action: 'agent', message: requestMessage,
        history: historyEnabled ? state.messages.slice(-24).map(({ role, content, blocks }) => ({ role, content: [content, ...(blocks ?? []).map((block) => `${block.title}\n${block.body}`)].join('\n\n') })) : [] },
        (preview) => { if (alive.current && !controller.signal.aborted) setLive(preview); }, controller.signal,
        (event) => {
          if (!alive.current || controller.signal.aborted) return;
          const nextCheckpoint = event.type === 'checkpoint' ? mergeAgentCheckpoint(checkpoint, event.checkpoint) : checkpoint;
          checkpoint = nextCheckpoint;
          updateProject((current) => {
            if (current.workbench?.[ownerId]?.agentRun?.id !== runId) return current;
            return updateWorkbench(current, ownerId, (work) => ({ ...work, agentRun: { ...work.agentRun!,
              ...(event.type === 'checkpoint' ? { checkpoint: nextCheckpoint } : { activities: [...work.agentRun!.activities.filter((item) => agentActivityKey(item) !== agentActivityKey(event.activity)), event.activity].slice(-100) }) } }));
          }, false);
        });
      if (!alive.current || controller.signal.aborted) return;
      const timestamp = nowIso();
      const drafts = agentDrafts(project, response, runScope, runTargets, instruction, timestamp);
      const changes: AgentMutation[] = (response.mutations ?? []).map((item) => ({ ...item, id: crypto.randomUUID(), createdAt: timestamp, status: 'pending' }));
      if (runScope !== 'project' && changes.length) throw new Error('Structural edits require project scope.');
      const userId = crypto.randomUUID(); const assistantId = crypto.randomUUID();
      updateProject((current) => {
        if (!current.workbench?.[ownerId] || (runScope === 'project' && current.workbench[ownerId].agentRun?.id !== runId)) return current;
        let next = runScope === 'project' ? applyAgentTransaction(current, drafts, changes, ownerId, response.preconditions) : applyAgentVersions(current, drafts, current.workbench[ownerId].targetNodeIds ?? [], ownerId);
        const applied = drafts.filter((draft) => next.workbench?.[ownerId]?.versions.find((item) => item.id === draft.id)?.status === 'accepted').length + (next.workbench?.[ownerId]?.mutations?.filter((item) => changes.some((change) => change.id === item.id) && item.status === 'accepted').length ?? 0);
        const totalChanges = drafts.length + changes.length;
        const summary = (totalChanges ? (zh ? `\n\n执行结果：已写入 ${applied} 项，待处理 ${totalChanges - applied} 项。可在修改记录中查看或回滚。` : `\n\nExecution: ${applied} applied, ${totalChanges - applied} awaiting review. Inspect or roll back in change history.`) : '') + (response.coverage ? (zh ? `\n覆盖范围：读取 ${response.coverage.readNodes} 个节点；任务清单完成 ${response.coverage.completed}/${response.coverage.planned} 项。项目共 ${response.coverage.projectNodes} 个节点。` : `\nCoverage: ${response.coverage.readNodes} nodes read; ${response.coverage.completed}/${response.coverage.planned} planned targets completed. Project contains ${response.coverage.projectNodes} nodes.`) : '');
        next = updateWorkbench(next, ownerId, (work) => ({ ...work, title: work.title || instruction.slice(0, 32),
          agentRun: runScope === 'project' ? { ...work.agentRun!, status: 'completed', checkpoint: null } : work.agentRun,
          messages: [...(response.blocks?.length ? work.messages.map((message) => ({ ...message, blocks: [] })) : work.messages),
          { id: userId, role: 'user', content: instruction, createdAt: timestamp },
          { id: assistantId, role: 'assistant', content: response.reply + summary, blocks: response.blocks ?? [], createdAt: timestamp }] }));
        return next;
      }, drafts.length > 0 || changes.length > 0);
      setInput((current) => current.trim() === instruction ? '' : current); setBase(null);
    } catch (e) {
      if (alive.current) {
        const message = controller.signal.aborted ? (zh ? '已停止，未写入本轮结果。全项目任务可从最近断点继续。' : 'Stopped without applying this run. Project tasks can resume from the latest checkpoint.') : e instanceof Error ? e.message : String(e);
        setError(message);
        if (runScope === 'project') updateProject((current) => current.workbench?.[ownerId]?.agentRun?.id !== runId ? current : updateWorkbench(current, ownerId,
          (work) => ({ ...work, agentRun: { ...work.agentRun!, status: controller.signal.aborted ? 'paused' : 'failed', error: message } })), false);
      }
    } finally { if (alive.current) { setBusy(false); setLive(null); } abortRef.current = null; }
  };
  const operate = (owner: string, id: string, rollback = false) => {
    try {
      (rollback ? rollbackVersion : acceptVersion)(project, owner, id);
      const messageId = crypto.randomUUID(); const timestamp = nowIso();
      updateProject((current) => {
        try {
          const next = (rollback ? rollbackVersion : acceptVersion)(current, owner, id);
          const title = current.workbench?.[owner]?.versions.find((item) => item.id === id)?.title ?? id;
          return updateWorkbench(next, ownerId, (work) => ({ ...work, messages: [...work.messages, { id: messageId, role: 'assistant', content: (rollback ? (zh ? '操作记录：已回滚「' : 'Activity: rolled back “') : (zh ? '操作记录：已采纳「' : 'Activity: accepted “')) + title + (zh ? '」。' : '”.'), createdAt: timestamp }] }));
        } catch { return current; }
      });
      setError('');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const continueVersion = (owner: string, version: DraftVersion) => { attach(version.status === 'accepted' ? version.appliedNodeId ?? version.targetNodeId ?? owner : version.targetNodeId ?? owner); setBase({ owner, id: version.id }); setCompare(null); };
  const statusLabel = (version: DraftVersion) => zh ? ({ pending: '待处理', accepted: '已写入', rejected: '已放弃', rolled_back: '已回滚' })[version.status] : ({ pending: 'Pending', accepted: 'Applied', rejected: 'Discarded', rolled_back: 'Rolled back' })[version.status];

  return <section className={`assistant-panel ${expanded ? 'expanded' : 'collapsed'} ${dragOver ? 'chat-drop-active' : ''}`} aria-label={zh ? '创作聊天' : 'Writing chat'}
    onDragOver={(event) => { if (event.dataTransfer.types.includes(CHAT_NODE_MIME)) { event.preventDefault(); event.dataTransfer.dropEffect = busy ? 'none' : 'copy'; setDragOver(true); } }}
    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(false); }}
    onDrop={(event) => { event.preventDefault(); setDragOver(false); attach(event.dataTransfer.getData(CHAT_NODE_MIME)); }}>
    <header className="chat-heading">
      <button className="chat-icon-button" aria-expanded={conversationsOpen} aria-label={conversationsOpen ? (zh ? '折叠会话列表' : 'Collapse conversations') : (zh ? '展开会话列表' : 'Expand conversations')} title={zh ? '显示 / 隐藏会话列表' : 'Toggle conversations'} onClick={onToggleConversations}><ChatIcon name="sidebar" /></button>
      <div className="chat-current-title" title={title}><ChatIcon name="chat" /><strong>{title}</strong></div>
      <span className="chat-folded-label">{zh ? '创作聊天' : 'Writing chat'}</span>
      {expanded && <div className="chat-heading-actions"><button className="chat-icon-button" aria-label={zh ? '创建对话' : 'Create conversation'} title={zh ? '新建对话' : 'New conversation'} onClick={onCreate}><ChatIcon name="plus" /></button><button className="chat-icon-button" aria-label={zh ? '删除对话' : 'Delete conversation'} title={zh ? '删除此对话' : 'Delete this conversation'} disabled={!project.workbench?.[ownerId]} onClick={onDelete}><ChatIcon name="delete" /></button></div>}
      <button className="chat-icon-button" aria-expanded={expanded} aria-label={expanded ? (zh ? '折叠聊天' : 'Collapse chat') : (zh ? '展开聊天' : 'Expand chat')} title={expanded ? (zh ? '折叠聊天' : 'Collapse chat') : (zh ? '展开聊天' : 'Expand chat')} onClick={onToggle}><ChatIcon name={expanded ? 'close' : 'chat'} /></button>
    </header>
    <div className={`chat-content ${!state.messages.length && !busy && !savedRun ? "is-new-conversation" : ""}`} hidden={!expanded}>
      <div ref={logRef} className="assistant-history" role="log" aria-label={zh ? '讨论记录' : 'Discussion history'} onScroll={(event) => { const element = event.currentTarget; followTail.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48; }}>
        {!state.messages.length && !busy && !savedRun && <p className="chat-welcome">{zh ? '讨论创作、修订全文，或拖入节点作为上下文。' : 'Explore an idea, revise your novel, or drop nodes for context.'}</p>}
        {state.messages.map((message) => <article key={message.id} className={message.role}><strong>{message.role === 'user' ? (zh ? '你' : 'You') : 'AI'}</strong>{message.content && <p>{message.content}</p>}{message.blocks?.map((block, index) => <ChatBlockCard key={index} block={block} />)}</article>)}
        {versions.length > 0 && <details className="chat-changes" open><summary>{zh ? '修改记录' : 'Change history'} ({versions.length})</summary>
          <button disabled={busy || generationBusy || !versions.some(({ version }) => version.status === 'accepted')} onClick={() => {
            try {
              rollbackAgentTransaction(project, ownerId);
              const messageId = crypto.randomUUID(); const timestamp = nowIso();
              updateProject((current) => {
                try { return updateWorkbench(rollbackAgentTransaction(current, ownerId), ownerId, (work) => ({ ...work,
                  messages: [...work.messages, { id: messageId, role: 'assistant', content: zh ? '操作记录：已回滚本轮全部修改。' : 'Activity: rolled back all changes from the latest batch.', createdAt: timestamp }] })); }
                catch { return current; }
              });
              setError('');
            } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
          }}>{zh ? '回滚本轮全部修改' : 'Roll back entire batch'}</button>
          {versions.map(({ owner, version }, index) => <article key={version.id} className="chat-change">
          <strong>v{index + 1} · {version.title}</strong><small>{statusLabel(version)} · {version.operation === 'create' ? (zh ? '新建节点' : 'Create node') : (zh ? '修改正文' : 'Replace body')}</small>
          {version.conflict && version.status === 'pending' && <p role="alert">{version.conflict}</p>}
          <div className="button-row"><button onClick={() => setCompare({ owner, id: version.id })}>{zh ? '查看对比' : 'Compare'}</button><button disabled={busy} onClick={() => continueVersion(owner, version)}>{zh ? '继续修改' : 'Continue revising'}</button>
            {version.status === 'accepted' && <button disabled={busy || generationBusy} onClick={() => operate(owner, version.id, true)}>{zh ? '回滚' : 'Roll back'}</button>}
            {version.status === 'pending' && <><button disabled={busy || generationBusy || mutations.some((m) => m.status === 'pending')} onClick={() => operate(owner, version.id)}>{zh ? '采纳候选' : 'Accept candidate'}</button><button disabled={busy} onClick={() => updateProject((current) => updateWorkbench(current, owner, (work) => ({ ...work, versions: work.versions.map((item) => item.id === version.id ? { ...item, status: 'rejected' } : item) })), false)}>{zh ? '放弃' : 'Discard'}</button></>}
          </div>
        </article>)}</details>}
        {mutations.length > 0 && <details className="chat-structure-changes" open><summary>{zh ? '结构与世界书改动' : 'Structure and worldbook changes'} ({mutations.length})</summary>
          {mutations.map((item) => <article key={item.id}><strong>{({ edge: zh ? '关系调整' : 'Relationship', worldbook: zh ? '世界书' : 'Worldbook', node_delete: zh ? '删除节点' : 'Deleted node', node_links: zh ? '关联更新' : 'Reference update' } as Record<string, string>)[item.kind]} · {String(item.after?.title ?? item.before?.title ?? project.nodes.find((node) => node.id === item.targetId)?.title ?? '')}</strong>
            <p>{item.status === 'accepted' ? (zh ? '已写入' : 'Applied') : item.status === 'rolled_back' ? (zh ? '已回滚' : 'Rolled back') : (zh ? '待处理' : 'Pending')}</p>
            {item.kind === 'worldbook' && <details><summary>{zh ? '查看前后内容' : 'Compare contents'}</summary><pre>{String(item.before?.content ?? '')}</pre><hr /><pre>{String(item.after?.content ?? '')}</pre></details>}
            {item.kind === 'node_delete' && <details><summary>{zh ? '查看删除的正文' : 'Inspect deleted text'}</summary><pre>{String(item.before?.body ?? '')}</pre></details>}
            {item.kind === 'edge' && <p>{[item.after ?? item.before].map((edge) => edge ? `${project.nodes.find((node) => node.id === edge.sourceNodeId)?.title ?? edge.sourceNodeId} → ${project.nodes.find((node) => node.id === edge.targetNodeId)?.title ?? edge.targetNodeId} · ${edge.semantic}` : '').join('')}</p>}
            {item.conflict && <p role="alert">{item.conflict}</p>}
          </article>)}
          {!versions.length && <button disabled={busy || generationBusy || !mutations.some((item) => item.status === 'accepted')} onClick={() => {
            try { rollbackAgentTransaction(project, ownerId); updateProject((current) => rollbackAgentTransaction(current, ownerId)); setError(''); }
            catch (e) { setError(e instanceof Error ? e.message : String(e)); }
          }}>{zh ? '回滚本轮全部修改' : 'Roll back entire batch'}</button>}
          {mutations.some((item) => item.status === 'pending') && <button disabled={busy || generationBusy} onClick={() => updateProject((current) => applyAgentTransaction(current, current.workbench![ownerId].versions, current.workbench![ownerId].mutations ?? [], ownerId, current.workbench![ownerId].agentPreconditions ?? undefined))}>{zh ? '重新尝试整批写入' : 'Retry entire batch'}</button>}
        </details>}
        {savedRun && <details className="agent-activity" open={busy || savedRun.status !== 'completed'}><summary>{zh ? 'Agent 执行过程' : 'Agent activity'} · {savedRun.activities.length ? savedRun.activities[savedRun.activities.length - 1].step : 0} {zh ? '步' : 'steps'}{Boolean(savedRun.activities[savedRun.activities.length - 1]?.planned) && ` · ${savedRun.activities[savedRun.activities.length - 1]?.completed ?? 0}/${savedRun.activities[savedRun.activities.length - 1]?.planned} ${zh ? '项完成' : 'targets completed'}`}</summary>
          <p>{savedRun.instruction}</p>
          <ol>{savedRun.activities.map((item) => <li key={agentActivityKey(item)}><strong>{item.step}. {agentToolLabel(item.tool, zh)}</strong>{(item.title || item.nodeId) && <span> · {item.title ?? project.nodes.find((node) => node.id === item.nodeId)?.title ?? item.nodeId}</span>}<p>{item.message}</p></li>)}</ol>
          {!busy && savedRun.status !== 'completed' && <div className="button-row"><button disabled={generationBusy || scope !== 'project'} onClick={() => void run(true)}>{zh ? '继续任务' : 'Resume task'}</button><button onClick={() => { change((work) => ({ ...work, agentRun: null })); setError(''); }}>{zh ? '放弃本轮暂存改动' : 'Discard staged run'}</button></div>}
          {!busy && !error && savedRun.error && savedRun.status !== 'completed' && <p role="alert">{savedRun.error}</p>}
        </details>}
        {busy && <><article className="user"><strong>{zh ? '你' : 'You'}</strong><p>{submitted}</p></article><article className="assistant streaming"><strong>AI</strong><p>{live?.reply}</p>{live?.blocks.map((block, index) => <ChatBlockCard key={index} block={{ ...block, title: block.title || (zh ? '报告生成中…' : 'Report in progress…') }} pending />)}{live?.edits.map((edit, index) => <details className="streaming-edit" key={index} open><summary>{edit.title || (zh ? '正在修改…' : 'Writing changes…')}</summary><pre>{edit.body}</pre></details>)}</article><p role="status">{zh ? '正在生成…' : 'Generating…'}</p></>}
      </div>
      <div className="chat-composer">
      <div className="chat-targets" aria-label={zh ? '聊天目标' : 'Chat targets'}>
        {targets.map((id) => <span className="chat-target" key={id}>{project.nodes.find((item) => item.id === id)?.title ?? (zh ? '已删除节点' : 'Deleted node')}<button disabled={busy} aria-label={`${zh ? '移除目标' : 'Remove target'} ${id}`} onClick={() => { change((current) => ({ ...current, targetNodeIds: current.targetNodeIds?.filter((item) => item !== id), referenceNodeIds: [] })); setBase(null); }}>×</button></span>)}

      </div>
      {targets.length > 0 && <details className="assistant-context"><summary>{zh ? '读取范围' : 'Read scope'} · {context?.nodes.length ?? '…'} {zh ? '节点' : 'nodes'} / {context?.worldbook.length ?? '…'} {zh ? '世界书' : 'lore'}</summary>
        <p className="helper-text">{scope === 'project' ? (zh ? 'Agent 可按需搜索、读取和修改全项目。下方为已挂入的重点资料。' : 'Agent can search, read and edit the project. Attached material is shown below.') : (zh ? '自动读取一层入向参考。只有目标可修改；其他节点只读。' : 'Reads one incoming layer automatically. Only attached targets are writable.')}</p>
        {context?.nodes.map((item) => <details key={item.id}><summary>{targets.includes(item.id) ? '✎ ' : '↳ '}{item.title}</summary><pre>{item.content}</pre></details>)}
        {scope === 'attached' && deeperIds.map((id) => <button key={id} disabled={busy} onClick={() => change((current) => ({ ...current, referenceNodeIds: [...new Set([...(current.referenceNodeIds ?? []), id])] }))}>{zh ? '授权读取：' : 'Allow reading: '}{project.nodes.find((item) => item.id === id)?.title ?? id}</button>)}
        {references.length > 0 && <button disabled={busy} onClick={() => change((current) => ({ ...current, referenceNodeIds: [] }))}>{zh ? '撤销额外读取授权' : 'Revoke expanded access'}</button>}
        {context?.worldbook.map((item) => <details key={item.id}><summary>{item.title}</summary><pre>{item.content}</pre></details>)}
        <label className="inline-check"><input type="checkbox" checked={historyEnabled} onChange={(e) => setHistoryEnabled(e.target.checked)} />{zh ? '带入最近 24 条对话（可能含先前授权的资料）' : 'Include last 24 messages (may contain previously authorized material)'}</label>
      </details>}

        {reviews.length > 0 && <details><summary>{zh ? '带入审阅意见' : 'Use review feedback'}</summary>{reviews.map((review) => <button key={review.id} onClick={() => setInput(review.body ?? '')}>{zh ? '带入反馈（可编辑）：' : 'Use as editable feedback: '}{review.title}</button>)}</details>}
        {baseVersion && <div className="helper-text">{zh ? '基于候选：' : 'From candidate: '}{baseVersion.title}<button onClick={() => setBase(null)}>×</button></div>}
        <textarea aria-label={zh ? '要求 / 修改反馈' : 'Request / feedback'} value={input} rows={!state.messages.length && !busy && !savedRun ? 6 : 3} placeholder={zh ? '提出创作要求，或拖入节点添加上下文…' : 'Describe an idea or a change. Drop nodes for context…'} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void run(); } }} />
        <div className="chat-send-row">
          <div className="chat-composer-options"><select className="chat-agent-mode" aria-label={zh ? "模式" : "Mode"} defaultValue="agent"><option value="agent">Agent</option></select><label className="inline-check"><span className="sr-only">{zh ? '工作范围' : 'Scope'}</span> <select aria-label={zh ? '工作范围' : 'Scope'} value={scope} disabled={busy} onChange={(event) => change((work) => ({ ...work, scope: event.target.value as 'project' | 'attached' }))}><option value="project">{zh ? '整部作品' : 'Entire project'}</option><option value="attached">{zh ? '仅挂入节点' : 'Attached nodes only'}</option></select></label></div>
          <div className="chat-composer-actions">{node && !targets.includes(node.id) && <button className="chat-icon-button" disabled={busy} aria-label={zh ? '加入选中节点' : '+ Attach selected node'} title={zh ? '加入选中节点' : 'Attach selected node'} onClick={() => attach(node.id)}><ChatIcon name="attach" /></button>}
            {busy ? <button className="chat-submit" aria-label={zh ? '停止' : 'Stop'} title={zh ? '停止' : 'Stop'} onClick={() => abortRef.current?.abort()}>■</button> : <button className="chat-submit" aria-label={zh ? '发送' : 'Send'} title={zh ? '发送 · Enter' : 'Send · Enter'} disabled={generationBusy || !input.trim() || (scope === 'attached' && (!context || Boolean(previewError)))} onClick={() => void run()}><ChatIcon name="send" /></button>}
          </div>
        </div>
        <div className="chat-composer-footnote"><span title={zh ? '在全局设置中选择聊天模型' : 'Chat model selected in global settings'}>{modelName || (zh ? '在设置中选择聊天模型' : 'Select a chat model in Settings')}</span><small>{zh ? 'Shift+Enter 换行' : 'Shift+Enter for newline'}</small></div>
        {(error || (scope === 'attached' && previewError)) && <p role="alert" className="error-text">{error || previewError}</p>}
      </div>
    </div>
    {inspected && compare && <WorkbenchDialog className="version-dialog" label={zh ? '版本对比' : 'Version comparison'} onClose={() => setCompare(null)}>
      <header><h2>{inspected.title}</h2><button autoFocus onClick={() => setCompare(null)}>{zh ? '关闭对比' : 'Close comparison'}</button></header>
      <div className="version-comparison"><section><h3>{zh ? '修改前正文' : 'Original text'}</h3><pre>{inspected.operation === 'create' ? '' : inspected.baseBody}</pre></section><section><h3>{zh ? '模型结果' : 'Model result'}</h3><pre>{inspected.body}</pre></section></div>
      <details><summary>{zh ? '要求与设计理由' : 'Request and rationale'}</summary><pre>{inspected.feedback + '\n\n' + inspected.rationale}</pre></details>
      <div className="button-row"><button onClick={() => continueVersion(compare.owner, inspected)}>{zh ? '继续修改' : 'Continue revising'}</button>
        {inspected.status === 'accepted' && <button disabled={busy || generationBusy} onClick={() => operate(compare.owner, inspected.id, true)}>{zh ? '回滚' : 'Roll back'}</button>}
        {inspected.status === 'pending' && <button disabled={busy || generationBusy || mutations.some((m) => m.status === 'pending')} onClick={() => operate(compare.owner, inspected.id)}>{zh ? '采纳候选' : 'Accept candidate'}</button>}
        {inspected.operation === 'replace' && <button disabled={busy} onClick={() => {
          const targetId = inspected.targetNodeId ?? compare.owner; const target = project.nodes.find((item) => item.id === targetId); if (!target) return;
          const id = crypto.randomUUID();
          updateProject((current) => addVersion(current, compare.owner, { ...inspected, id, targetNodeId: targetId, body: inspected.baseBody, baseBody: target.body ?? '', title: zh ? '恢复历史原文' : 'Restore historical text', status: 'pending', conflict: '', createdAt: nowIso() }), false);
          setCompare({ owner: compare.owner, id });
        }}>{zh ? '将原文作为恢复候选' : 'Restore original as candidate'}</button>}
      </div>{error && <p role="alert">{error}</p>}
    </WorkbenchDialog>}
  </section>;
}
