import { useState } from 'react';
import { useI18n } from './i18n';
import type { ChatBlock } from './types';

export function ChatBlockCard({ block, pending = false }: { block: ChatBlock; pending?: boolean }) {
  const { locale } = useI18n(); const zh = locale === 'zh-CN';
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  return <section className="chat-block" aria-label={block.title}>
    <details open><summary>{block.title}</summary><pre>{block.body}</pre></details>
    <footer><button disabled={pending} onClick={async () => {
      try { await navigator.clipboard.writeText(`${block.title}\n\n${block.body}`); setCopied(true); setError(''); }
      catch { setError(zh ? '复制失败，请选择正文手动复制。' : 'Copy failed. Select the text to copy it manually.'); }
    }}>{copied ? (zh ? '已复制全文' : 'Full text copied') : (zh ? '复制全文' : 'Copy full text')}</button></footer>
    {error && <p role="alert">{error}</p>}
  </section>;
}
