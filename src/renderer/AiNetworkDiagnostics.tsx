import {useRef,useState} from 'react';
import type {AiNetworkReport} from '../shared/ai-network-contracts';
import {errorText,formatDate} from './utils';
const states={HTTP_RESPONSE:'收到 HTTP 响应',TIMEOUT:'诊断超时',NETWORK_ERROR:'网络连接失败',PROXY_ERROR:'代理规则解析失败'};
export function AiNetworkDiagnostics(){
  const [report,setReport]=useState<AiNetworkReport|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const pending=useRef(false);
  async function inspect(){if(pending.current)return;pending.current=true;setBusy(true);setError('');try{setReport(await window.red.diagnoseAiNetwork());}catch(cause){setError(errorText(cause));}finally{pending.current=false;setBusy(false);}}
  return <section aria-label="AI 网络诊断" className="settings-module">
    <h4>AI 网络与系统代理</h4>
    <p>AI 请求跟随系统代理规则，包括 OpenRouter 文案、生图、Decisions、Batch，以及 DeepSeek 和阿里云。切换线路后，新请求按当前规则连接；在途请求不会被中断。</p>
    <button type="button" disabled={busy} onClick={()=>void inspect()}>{busy?'正在诊断…':'检查 AI 网络（不调用模型）'}</button>
    <p className="muted">仅手动向固定服务地址发送无 Key 的 HEAD 请求，不生成内容、不扣模型额度。显示的是匹配的代理候选规则，非实际出口 IP；出口国家未检测。DIRECT 表示规则允许直连，TUN 接管不体现在此规则中。</p>
    {error&&<p role="alert">{error}</p>}
    {report&&<><p>检查时间：{formatDate(report.checkedAt)}。收到 HTTP 响应（包括 401 / 403 / 405）仅说明有响应，不代表 Key、余额或模型地区权限通过。</p><ul>{report.targets.map(target=><li key={target.url}><strong>{target.name}</strong> · {states[target.state]}{target.httpStatus!==undefined?` HTTP ${target.httpStatus}`:''} · {target.elapsedMs} ms<br/>{target.url} · 匹配代理规则：{target.route}</li>)}</ul></>}
  </section>;
}
