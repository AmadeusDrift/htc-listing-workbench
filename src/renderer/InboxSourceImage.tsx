import { useEffect, useId, useState } from 'react';
import { ImageIcon, LoaderCircle, RotateCw } from 'lucide-react';
import { errorText } from './utils';

interface Props {
  productId: string; imageId?: string | null; localUrl?: string | null; alt: string;
  version?: 'imported' | 'latest';
  className?: string; onOpen?: () => void; openLabel?: string;
}

export function InboxSourceImage({ productId, imageId, localUrl, alt, version = 'imported', className = '', onOpen, openLabel }: Props) {
  const [preview, setPreview] = useState<string | null>(null), [error, setError] = useState('');
  const [loading, setLoading] = useState(false), [attempt, setAttempt] = useState(0);
  const errorId = useId();
  useEffect(() => {
    let active = true;
    setPreview(null); setError(''); setLoading(false);
    if (localUrl) { setPreview(localUrl); return; }
    if (!imageId) return;
    setLoading(true);
    void window.red.previewMiaoshouImage({ productId, imageId, version }).then(value => { if (active) setPreview(value); }, cause => { if (active) setError(errorText(cause)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [productId, imageId, localUrl, version, attempt]);
  const content = preview ? <img src={preview} alt={alt} loading="lazy" decoding="async" onError={() => { setPreview(null); setError('图片暂时无法显示'); }} />
    : <span className="inbox-image-placeholder" aria-label={loading ? '图片加载中' : error ? '图片加载失败' : '暂无图片'}>{loading ? <LoaderCircle size={20} className="spin" /> : <ImageIcon size={24} strokeWidth={1.35} />}<span>{loading ? '加载中' : error ? '加载失败' : '暂无图片'}</span></span>;
  return <div className={`inbox-source-image ${className}`} aria-busy={loading} title={error || undefined}>
    {onOpen ? <button type="button" className="inbox-image-open" aria-label={openLabel ?? `查看图片 ${alt}`} aria-describedby={error ? errorId : undefined} onClick={onOpen}>{content}</button> : content}
    {error && <><span className="inbox-image-error" id={errorId}>{error}</span><button type="button" className="inbox-image-retry" aria-label={`重试图片 ${alt}`} aria-describedby={errorId} onClick={() => setAttempt(value => value + 1)}><RotateCw size={12} /><span>重试</span></button></>}
  </div>;
}
