import type {AiNetworkReport,AiNetworkTargetResult} from '../shared/ai-network-contracts.ts';
type NativeFetch = (url: string | Request, options?: RequestInit & {bypassCustomProtocolHandlers?:boolean}) => Promise<Response>;
/** Electron default-session fetch: no Node fallback or retry; preserves cancellation and journals. */
export function createSystemProxyFetch(nativeFetch:NativeFetch):typeof fetch {
  return (url,options)=>nativeFetch(url instanceof URL?url.href:url,{...options,bypassCustomProtocolHandlers:true});
}
const targets = [
  {name:'OpenRouter（文案 / Decisions / 生图 / Batch）',url:'https://openrouter.ai/'},
  {name:'DeepSeek',url:'https://api.deepseek.com/'},
  {name:'阿里云 OCR',url:'https://ocr-api.cn-hangzhou.aliyuncs.com/'},
  {name:'阿里云图片风险',url:'https://green-cip.cn-shanghai.aliyuncs.com/'},
  {name:'阿里云抠图',url:'https://aidge.cn-beijing.aliyuncs.com/'},
] as const;
/** PAC output is untrusted and can contain credentials. Keep routing kinds only. */
export function sanitizeProxyRoute(raw:string):string {
  if(raw.length>4096)return '代理规则未识别';
  return raw.split(';').slice(0,16).map(value=>{
    const entry=value.trim();if(entry==='DIRECT')return 'DIRECT';
    const kind=/^(PROXY|HTTPS|SOCKS|SOCKS4|SOCKS5)\s+\S+$/i.exec(entry)?.[1];
    return kind?`${kind.toUpperCase()} [地址已隐藏]`:'代理规则未识别';
  }).join('; ');
}
export function createAiNetworkDiagnostics(deps:{fetch:typeof fetch;resolveProxy:(url:string)=>Promise<string>;timeoutMs?:number}):()=>Promise<AiNetworkReport>{
  let active:Promise<AiNetworkReport>|undefined;
  const timeoutMs=deps.timeoutMs??8000;
  async function inspect(target:typeof targets[number]):Promise<AiNetworkTargetResult>{
    const start=Date.now(),controller=new AbortController();let route='尚未解析',phase:'proxy'|'network'='proxy',timer:ReturnType<typeof setTimeout>|undefined;
    const result=(state:AiNetworkTargetResult['state'],httpStatus?:number):AiNetworkTargetResult=>({...target,route,state,elapsedMs:Date.now()-start,...(httpStatus===undefined?{}:{httpStatus})});
    const work=async()=>{
      try{
        route=sanitizeProxyRoute(await deps.resolveProxy(target.url));
        if(controller.signal.aborted)return result('TIMEOUT');
        phase='network';
        // HEAD only: no paid endpoint, auth, cookies, redirects, body download or task state.
        const response=await deps.fetch(target.url,{method:'HEAD',credentials:'omit',redirect:'manual',cache:'no-store',signal:controller.signal});
        void response.body?.cancel().catch(()=>{});
        return result('HTTP_RESPONSE',response.status);
      }catch{return result(controller.signal.aborted?'TIMEOUT':phase==='proxy'?'PROXY_ERROR':'NETWORK_ERROR');}
    };
    try{return await Promise.race([work(),new Promise<AiNetworkTargetResult>(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(result('TIMEOUT'));},timeoutMs);})]);}
    finally{clearTimeout(timer);}
  }
  return ()=>{
    if(!active)active=Promise.all(targets.map(inspect)).then(rows=>({checkedAt:new Date().toISOString(),targets:rows})).finally(()=>{active=undefined;});
    return active;
  };
}
