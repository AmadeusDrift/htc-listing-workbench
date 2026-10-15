import { useEffect,useState } from 'react';
import type { AutomaticOperationProgress } from '../shared/automatic-listing-contracts';

/** Main-process progress events only: no timer and no database poll. */
export function AutomaticOperationStatus({taskId,starting=false}:{taskId?:string;starting?:boolean}){
 const [progress,setProgress]=useState<AutomaticOperationProgress|null>(null);
 useEffect(()=>{let active=true,received=false;const stop=window.red.onAutomaticOperationProgress?.(value=>{received=true;if(active)setProgress(value);});void window.red.getAutomaticOperationProgress?.().then(value=>{if(active&&!received)setProgress(value);}).catch(()=>{});return()=>{active=false;stop?.();};},[]);
 const current=progress&&(!taskId||progress.taskId===taskId)?progress:null;
 if(!current&&!starting)return null;
 return <div className="workflow-notice" role="status" aria-live="polite"><p>{current?.message??'正在准备启动并保存任务，请稍候…'}</p>{current&&<><progress aria-label={current.message} value={current.completed} max={Math.max(1,current.total)}/><span> {current.completed} / {current.total}</span></>}</div>;
}
