import { spawn } from 'node:child_process';
const EXE='E:/Midi/FuFumidi/FuFumidi.exe', PORT=9233;
const child=spawn(EXE,[],{env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+PORT},stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let target=null;
for(let i=0;i<60;i++){try{const list=await (await fetch('http://127.0.0.1:'+PORT+'/json/list')).json();target=list.find(t=>t.type==='page'&&!/splash\.html/.test(t.url||'')&&/tauri\.localhost|index\.html/.test(t.url||''));if(target)break;}catch(e){}await sleep(300);}
if(!target){console.error('no target');child.kill();process.exit(1);}
const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
let id=0;const ev=(expr)=>new Promise((resolve,reject)=>{const n=++id;const h=e=>{const m=JSON.parse(e.data);if(m.id===n){ws.removeEventListener('message',h);resolve(m.result&&m.result.result&&m.result.result.value);}};ws.addEventListener('message',h);ws.send(JSON.stringify({id:n,method:'Runtime.evaluate',params:{expression:expr,returnByValue:true,awaitPromise:true}}));setTimeout(()=>reject(new Error('timeout')),15000);});
console.log('url',target.url);
console.log('playlists',await ev("localStorage.getItem('fufumidi_playlists_v1')"));
console.log('dbPlaylists',await ev("window.fuBridge.dbPlaylistsList().then(x=>JSON.stringify({n:x.length, first:x.slice(0,2)}))"));
console.log('text',String(await ev("document.body.innerText")).slice(0,600));
console.log('weFetch',await ev("(async()=>{const inv=await window.fuBridge.wallpaperEngine.inventory(true);const it=(inv.items||[])[0];const v=await window.fuBridge.wallpaperEngine.view(it.id);const port=new URLSearchParams(v.url.split('?')[1]).get('wePort');const r=await fetch('http://127.0.0.1:'+port+'/'+it.id+'/project.json');return String(r.status)+' '+String(await r.text()).slice(0,80);})()"));
console.log('bridgeKeys',await ev("Object.keys(window.fuBridge||{}).length"));
console.log('wallpaper',JSON.stringify(await ev("window.fuBridge.wallpaperEngine.detect()")));
console.log('wallpaperView',await ev("(async()=>{const inv=await window.fuBridge.wallpaperEngine.inventory(true); const it=(inv.items||[])[0]; if(!it) return 'no-items'; const v=await window.fuBridge.wallpaperEngine.view(it.id); let fetchStatus=''; try{fetchStatus=String((await fetch(v.url)).status)}catch(e){fetchStatus=String(e)} return JSON.stringify({id:it.id,title:it.title,type:it.type,url:v.url,fetchStatus});})()"));
ws.close();child.kill();
