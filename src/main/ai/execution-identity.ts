/** Only the response's model and documented selected/successful router endpoint identify execution. */
export function openRouterExecutionIdentity(raw:unknown,status:number):{actualModel:string|null;actualProvider:string|null}{
 const value=(v:unknown)=>typeof v==='string'&&v.length>0&&v.length<=200&&/^[-a-zA-Z0-9_.:/ ()]+$/.test(v)&&!v.includes('sk-or-')?v:null;
 const body=raw as any,actualModel=value(body?.model),metadata=body?.openrouter_metadata;
 if(status<200||status>=300||body?.error)return{actualModel,actualProvider:null};
 const attempts=metadata?.attempts,available=metadata?.endpoints?.available;
 // A fallback trail is stronger evidence than an initial candidate selection. Ambiguity is not guessed.
 const candidates=Array.isArray(attempts)?attempts.filter(v=>Number.isInteger(v?.status)&&v.status>=200&&v.status<300):Array.isArray(available)?available.filter(v=>v?.selected===true):[];
 if(candidates.length!==1)return{actualModel,actualProvider:null};
 const endpoint=candidates[0],model=value(endpoint?.model),provider=value(endpoint?.provider);
 if(!provider||!model||actualModel!==null&&model!==actualModel)return{actualModel,actualProvider:null};
 return{actualModel:actualModel??model,actualProvider:provider};
}
