import { ImageIcon, Maximize2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AutomaticImageCandidatePreview, ImageWorkflowSlot } from '../shared/image-workflow-contracts';

function ImagePreviewDialog({ url, title, description, onClose }: { url:string; title:string; description:string; onClose:()=>void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return createPortal(<dialog ref={dialog} className="image-slot-dialog" aria-label="自动图片预览" onClose={onClose} onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
    <div className="image-slot-dialog-heading"><div><strong>{title}</strong><p>{description}</p></div><button type="button" className="icon-button" aria-label="关闭图片预览" onClick={() => dialog.current?.close()} autoFocus><X size={22}/></button></div>
    <img src={url} alt={title}/>
  </dialog>, document.body);
}

/** Previewing only reads saved local bytes. Approval and generation stay in the existing workflow. */
export function ImageSlotPreview({ draftId, slot, sku, title }: { draftId:string; slot:ImageWorkflowSlot; sku:string; title:string }) {
  const approved = slot.status === 'PASSED' && Boolean(slot.approvedAssetId);
  const candidateAttempt = slot.attempts.findLast(attempt => Boolean(attempt.candidateId));
  const candidateId = approved ? null : candidateAttempt?.candidateId;
  const [candidate, setCandidate] = useState<AutomaticImageCandidatePreview | null>(null);
  const [unavailable, setUnavailable] = useState(false), [imageError, setImageError] = useState(false), [opened, setOpened] = useState(false), [readRevision, setReadRevision] = useState(0),[requested,setRequested]=useState(false);
  useEffect(() => {
    if (!candidateId||!requested) return;
    let current = true;
    setCandidate(null); setUnavailable(false); setImageError(false);
    window.red.getAutomaticImageCandidatePreview({ draftId, slot:slot.index, candidateId }).then(value => {
      if (current && value.candidateId === candidateId) setCandidate(value);
    }).catch(() => { if (current) setUnavailable(true); });
    return () => { current = false; };
  }, [draftId, slot.index, candidateId, readRevision,requested]);
  const url = approved ? `red-asset://image/${slot.approvedAssetId}` : candidate?.previewUrl;
  const previous = candidateAttempt && candidateAttempt.number !== slot.attempts.at(-1)?.number;
  const adoption = approved ? '已采用' : previous ? '上次生成候选 · 未采用' : '生成候选 · 未采用';
  const description = `${adoption}${candidate ? ` · ${candidate.width} × ${candidate.height} px` : ''}`;
  return <>
    {url && !imageError ? <button type="button" className="image-slot-thumbnail" aria-label={`查看大图：${sku} · ${title} · ${adoption}`} onClick={() => setOpened(true)}>
      <img src={url} alt={`${sku} · ${title}`} onError={() => setImageError(true)}/><span><Maximize2 size={13}/>查看大图</span>
    </button> : <div className="image-slot-placeholder"><ImageIcon size={24} aria-hidden="true"/><span>{imageError ? '本地图片预览暂不可读' : unavailable ? '本地候选预览暂不可读' : candidateId ? requested?'正在读取本地预览…':'候选已保存，按需读取预览' : slot.status === 'RUNNING' ? '正在准备图片…' : '尚未生成图片'}</span>
      {candidateId&&!requested&&<button type="button" className="image-slot-read-retry" onClick={()=>setRequested(true)}>读取候选预览</button>}
      {(unavailable || imageError) && <button type="button" className="image-slot-read-retry" onClick={() => { setImageError(false); setReadRevision(value => value + 1); }}>重新读取预览</button>}
    </div>}
    {(approved || candidateId) && <span className="image-slot-adoption" data-adopted={approved}>{adoption}</span>}
    {opened && url && <ImagePreviewDialog url={url} title={`${sku} · ${title}`} description={description} onClose={() => setOpened(false)}/>}
  </>;
}
