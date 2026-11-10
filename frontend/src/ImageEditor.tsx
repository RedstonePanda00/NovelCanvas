import { useEffect, useRef, useState } from 'react';
import { useI18n } from './i18n';
import type { ImageAttachment } from './types';

export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

export async function readImage(file: File): Promise<ImageAttachment> {
  if (!IMAGE_ACCEPT.split(',').includes(file.type)) throw new Error('请选择 PNG、JPEG、WebP 或 GIF 图片 / Unsupported image format');
  if (file.size > 2 * 1024 * 1024) throw new Error('图片不能超过 2 MB / Maximum image size: 2 MB');
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('无法读取图片 / Could not read image'));
    reader.readAsDataURL(file);
  });
  await new Promise<void>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('图片文件已损坏 / Invalid image file'));
    image.src = dataUrl;
  });
  return { dataUrl, fileName: file.name.slice(0, 255) };
}

export function ImageEditor({ image, alt, disabled = false, onChange }: {
  image?: ImageAttachment | null; alt: string; disabled?: boolean;
  onChange: (image: ImageAttachment | null) => void;
}) {
  const { locale } = useI18n();
  const zh = locale === 'zh-CN';
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const revision = useRef(0);
  useEffect(() => () => { revision.current += 1; }, []);
  async function upload(file?: File) {
    if (!file) return;
    const request = ++revision.current;
    setBusy(true); setError('');
    try {
      const result = await readImage(file);
      if (request === revision.current) onChange(result);
    } catch (e) { if (request === revision.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (request === revision.current) setBusy(false); }
  }
  return <div className="image-editor" onClick={event => event.stopPropagation()}>
    {image ? <img className="illustration-preview" src={image.dataUrl} alt={alt || image.fileName} draggable={false} /> : <div className="image-placeholder">{zh ? '为世界或片段配一张插画' : 'Illustrate your world or scene'}</div>}
    <div className="image-actions">
      <label className="button-like secondary">{busy ? (zh ? '读取中…' : 'Loading…') : image ? (zh ? '替换图片' : 'Replace image') : (zh ? '上传图片' : 'Upload image')}
        <input aria-label={zh ? '上传图片' : 'Upload image'} type="file" accept={IMAGE_ACCEPT} disabled={disabled || busy} onChange={event => { void upload(event.target.files?.[0]); event.target.value = ''; }} />
      </label>
      {image ? <button type="button" className="secondary" disabled={disabled || busy} onClick={() => onChange(null)}>{zh ? '移除图片' : 'Remove image'}</button> : null}
    </div>
    <small className="helper-text">PNG / JPEG / WebP / GIF · ≤ 2 MB</small>
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}
