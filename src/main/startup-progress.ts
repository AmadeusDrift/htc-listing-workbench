import { BrowserWindow } from 'electron';

/** No preload, IPC or business controls exist until startup safety checks finish. */
export async function createStartupProgress(hidden:boolean){
  const window=new BrowserWindow({width:520,height:230,resizable:false,show:!hidden,title:'HTC · 正在启动',
    webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  let finished=false;
  window.on('close',event=>{if(!finished)event.preventDefault();});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>body{font-family:system-ui,sans-serif;padding:24px;background:#f6f7f9;color:#243147}h2{font-size:19px}p{font-size:14px;line-height:1.6;color:#536278}</style></head><body><h2>正在启动 HTC 工作台</h2><p id="stage">正在确认上次退出状态…</p><p>必要安全检查完成后，将自动进入工作台。</p></body></html>`;
  await window.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));
  return{
    focus:()=>{if(!window.isDestroyed())window.focus();},
    async stage(text:string){if(window.isDestroyed())return;window.setTitle('HTC · '+text);await window.webContents.executeJavaScript(`document.getElementById('stage').textContent=${JSON.stringify(text)}`).catch(()=>{});},
    close(){finished=true;if(!window.isDestroyed())window.destroy();},
  };
}
