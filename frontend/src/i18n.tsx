import React, { createContext, useContext, useMemo, useState } from 'react';

const en = {
  appName: 'Novel Canvas', canvas: 'Canvas', memory: 'Memory', worldbook: 'Worldbook', prompts: 'Prompts',
  export: 'Export', settings: 'Settings', project: 'Project', saveNow: 'Save now', saving: 'Saving…',
  saved: 'Saved', dirty: 'Unsaved changes', saveFailed: 'Save failed', retry: 'Retry', newProject: 'New project',
  loadProject: 'Import project', backupProject: 'Export project backup', language: 'Language', close: 'Close',
  nodes: 'Nodes', navigator: 'Navigator', inspector: 'Inspector', searchNodes: 'Search nodes…', allTypes: 'All types',
  fitAll: 'Fit all', fitSelection: 'Fit selection', resetView: 'Reset view', undo: 'Undo', redo: 'Redo',
  addNodeHint: 'Choose a node type, then click the canvas to place it.', emptyCanvas: 'Add the first node to begin.',
  chatModel: 'Chat model (global)', chatModelHint: 'Used for design discussion and revision across projects. Existing generation routes stay separate.',
  confirmReplaceWorldbook: 'Replace all current Worldbook entries with the imported entries?',
  title: 'Title', body: 'Content', tags: 'Tags', type: 'Type', relationships: 'Relationships', incoming: 'Incoming',
  outgoing: 'Outgoing', noSelection: 'Select a node or relationship to inspect it.', deleteNode: 'Delete node',
  deleteEdge: 'Delete relationship', contextPreview: 'AI context', refresh: 'Refresh', contextEmpty: 'No direct context.',
  excluded: 'Excluded', tokens: 'estimated tokens', staleMemory: 'Memory is out of date', aiWorkflow: 'AI workflow',
  generateOutline: 'Generate outline', completeOutline: 'Complete outline', generateScenes: 'Generate scenes',
  splitScene: 'Split scene', nextScene: 'Generate next scene', paragraphTask: 'Create paragraph task',
  createReview: 'Create review node', generateParagraph: 'Generate paragraph', generateReview: 'Generate review',
  replace: 'Replace', append: 'Append', sceneCount: 'Scene count', generating: 'Generating…', cancel: 'Cancel',
  accept: 'Accept', reject: 'Reject', pendingPlan: 'Pending plan', planReady: 'Plan ready for review.',
  childNodes: 'Chapter contents', addChild: 'Add child', remove: 'Remove', moveUp: 'Move up', moveDown: 'Move down',
  memoryTitle: 'Project Memory', memoryDescription: 'Semantic memory built only from scene and paragraph nodes.',
  rebuildMemory: 'Rebuild memory index', noPaidAuto: 'Embedding requests run only when you press rebuild.',
  indexedSources: 'Indexed sources', embeddingModel: 'Embedding model', unavailable: 'Unavailable',
  worldbookDescription: 'Triggered project lore maintained independently from character nodes.', addEntry: 'Add entry',
  importWorldbook: 'Import Worldbook', exportWorldbook: 'Export Worldbook', keys: 'Keys', enabled: 'Enabled',
  alwaysOn: 'Always on', priority: 'Priority', tokenBudget: 'Token budget', insertion: 'Insertion', content: 'Content',
  exportTitle: 'Manuscript export', exportMode: 'Export mode', assets: 'Assets', manuscript: 'Manuscript',
  selectAll: 'Select all', clear: 'Clear', exportTxt: 'Export TXT', exportHint: 'No selection exports every eligible node.',
  provider: 'Provider', providerId: 'Provider ID', providerName: 'Provider name', apiRoot: 'API root URL',
  apiKey: 'API key', keepKeyHint: 'Leave blank to keep the saved key.', clearSavedKey: 'Clear saved key',
  customHeaders: 'Custom headers JSON', saveProvider: 'Save provider', discoverModels: 'Discover models',
  testProvider: 'Test provider', models: 'Models', discoveredModel: 'Discovered model', registerModel: 'Register model',
  capabilities: 'Capabilities', contextWindow: 'Context window', embeddingDimensions: 'Embedding dimensions',
  registeredModels: 'Registered models', modelRouting: 'Model routing', projectLanguage: 'Writing language',
  structure: 'Structure', paragraph: 'Paragraph', review: 'Review', compression: 'Compression', embedding: 'Embedding',
  promptEditor: 'Model prompts', globalPrompt: 'Global prompt', promptHint: 'Task instructions take priority.',
  loading: 'Loading…', failedToLoad: 'Could not load the project.', confirmDeleteNode: 'Delete this node and its relationships?',
  confirmDeleteEdge: 'Delete this relationship?', confirmReplaceProject: 'Replace the current project?',
  projectLoaded: 'Project loaded.', projectImported: 'Project imported.', backupCreated: 'Project backup created.',
  generationFailed: 'Generation failed', streamCanceled: 'Generation canceled. Partial preview was kept.',
  noModel: 'Configure a routed model in Settings first.', invalidHeaders: 'Custom headers must be a JSON object.',
  localeEnglish: 'English', localeChinese: '简体中文', mobileMenu: 'Open navigation', projectMenu: 'Project menu',
  zoomIn: 'Zoom in', zoomOut: 'Zoom out', minimap: 'Minimap', connectionStart: 'Start connection',
  connectionEnd: 'Connect here', relationshipSemantic: 'Relationship semantic', saveBeforeClose: 'Changes are saved automatically.',
};

const zh: Record<keyof typeof en, string> = {
  appName: 'Novel Canvas', canvas: '画布', memory: '项目记忆', worldbook: '世界书', prompts: '提示词', export: '导出',
  settings: '设置', project: '项目', saveNow: '立即保存', saving: '正在保存…', saved: '已保存', dirty: '有未保存修改',
  saveFailed: '保存失败', retry: '重试', newProject: '新建项目', loadProject: '导入项目', backupProject: '导出项目备份',
  language: '语言', close: '关闭', nodes: '节点', navigator: '导航器', inspector: '检查器', searchNodes: '搜索节点…',
  allTypes: '全部类型', fitAll: '适配全部', fitSelection: '适配选中', resetView: '重置视图', undo: '撤销', redo: '重做',
  chatModel: '聊天模型（全局）', chatModelHint: '用于所有项目的设计讨论和反馈修改，与原有生成模型独立。',
  confirmReplaceWorldbook: '用导入的条目替换当前全部世界书条目？',
  addNodeHint: '选择节点类型，然后点击画布放置。', emptyCanvas: '添加第一个节点开始创作。', title: '标题', body: '内容',
  tags: '标签', type: '类型', relationships: '关系', incoming: '传入', outgoing: '传出', noSelection: '选择节点或关系以查看详情。',
  deleteNode: '删除节点', deleteEdge: '删除关系', contextPreview: 'AI 上下文', refresh: '刷新', contextEmpty: '没有直接上下文。',
  excluded: '已排除', tokens: '估算 Token', staleMemory: '项目记忆已过期', aiWorkflow: 'AI 工作流', generateOutline: '生成大纲',
  completeOutline: '补全大纲', generateScenes: '生成场景', splitScene: '拆分场景', nextScene: '生成下一场景',
  paragraphTask: '创建段落任务', createReview: '创建审阅节点', generateParagraph: '生成段落', generateReview: '生成审阅',
  replace: '替换', append: '续写', sceneCount: '场景数量', generating: '正在生成…', cancel: '取消', accept: '接受', reject: '拒绝',
  pendingPlan: '待确认方案', planReady: '方案已生成，请确认。', childNodes: '章节内容', addChild: '添加子节点', remove: '移除',
  moveUp: '上移', moveDown: '下移', memoryTitle: '项目记忆', memoryDescription: '仅由场景和段落节点构建的语义记忆。',
  rebuildMemory: '重建记忆索引', noPaidAuto: '只有点击重建时才会调用 Embedding。', indexedSources: '已索引来源',
  embeddingModel: 'Embedding 模型', unavailable: '不可用', worldbookDescription: '独立于角色节点、由用户维护的触发式设定资料。',
  addEntry: '新增条目', importWorldbook: '导入世界书', exportWorldbook: '导出世界书', keys: '触发词', enabled: '启用',
  alwaysOn: '始终启用', priority: '优先级', tokenBudget: 'Token 预算', insertion: '插入位置', content: '内容',
  exportTitle: '稿件导出', exportMode: '导出模式', assets: '素材', manuscript: '正文', selectAll: '全选', clear: '清空',
  exportTxt: '导出 TXT', exportHint: '未选择节点时会导出所有符合条件的节点。', provider: '服务商', providerId: '服务商 ID',
  providerName: '服务商名称', apiRoot: 'API 根地址', apiKey: 'API 密钥', keepKeyHint: '留空会保留已保存的密钥。',
  clearSavedKey: '清除已保存密钥', customHeaders: '自定义请求头 JSON', saveProvider: '保存服务商', discoverModels: '发现模型',
  testProvider: '测试服务商', models: '模型', discoveredModel: '发现的模型', registerModel: '注册模型', capabilities: '能力',
  contextWindow: '上下文窗口', embeddingDimensions: 'Embedding 维度', registeredModels: '已注册模型', modelRouting: '模型路由',
  projectLanguage: '写作语言', structure: '结构', paragraph: '段落', review: '审阅', compression: '压缩', embedding: 'Embedding',
  promptEditor: '模型提示词', globalPrompt: '全局提示词', promptHint: '任务指令优先级高于全局提示词。', loading: '正在加载…',
  failedToLoad: '无法加载项目。', confirmDeleteNode: '删除此节点及其全部关系？', confirmDeleteEdge: '删除此关系？',
  confirmReplaceProject: '替换当前项目？', projectLoaded: '项目已加载。', projectImported: '项目已导入。', backupCreated: '项目备份已导出。',
  generationFailed: '生成失败', streamCanceled: '生成已取消，已保留部分预览。', noModel: '请先在设置中配置模型路由。',
  invalidHeaders: '自定义请求头必须是 JSON 对象。', localeEnglish: 'English', localeChinese: '简体中文',
  mobileMenu: '打开导航', projectMenu: '项目菜单', zoomIn: '放大', zoomOut: '缩小', minimap: '缩略图',
  connectionStart: '开始连接', connectionEnd: '连接到这里', relationshipSemantic: '关系语义', saveBeforeClose: '修改会自动保存。',
};

export type TranslationKey = keyof typeof en;
export type Locale = 'en' | 'zh-CN';

interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: TranslationKey) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

function initialLocale(): Locale {
  const saved = localStorage.getItem('novel-canvas-ui-locale');
  if (saved === 'en' || saved === 'zh-CN') return saved;
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const value = useMemo<I18nValue>(() => ({
    locale,
    setLocale(next) {
      localStorage.setItem('novel-canvas-ui-locale', next);
      document.documentElement.lang = next;
      setLocaleState(next);
    },
    t: (key) => (locale === 'zh-CN' ? zh[key] : en[key]),
  }), [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used within I18nProvider');
  return value;
}
