import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
const ROOT=path.resolve(import.meta.dirname,'..','..');
const ELECTRON=path.join(ROOT,'node_modules','electron','dist','electron.exe');
const port=9555;
const env={...process.env,FUFUMIDI_E2E:'1',FUFUMIDI_E2E_HIDDEN:'1',FUFUMIDI_E2E_DATA_ROOT:path.join('E:/Midi/FuFumidi/FuFumidiData')};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(ELECTRON,[ROOT,'--remote-debugging-port='+port,'--user-data-dir='+path.join(process.env.APPDATA,'FuFumidi')],{cwd:ROOT,env,stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let target=null;
for(let i=0;i<100;i++){try{const list=await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();target=list.find(t=>t.type==='page'&&/index\.html/.test(t.url||''));if(target)break;}catch(e){}await sleep(300);}
if(!target){console.error('no target');child.kill();process.exit(1);}
const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
let id=0;const evalp=(expr)=>new Promise((resolve,reject)=>{const n=++id;const h=e=>{const m=JSON.parse(e.data);if(m.id===n){ws.removeEventListener('message',h);resolve(m.result&&m.result.result&&m.result.result.value);}};ws.addEventListener('message',h);ws.send(JSON.stringify({id:n,method:'Runtime.evaluate',params:{expression:expr,returnByValue:true,awaitPromise:true}}));setTimeout(()=>reject(new Error('timeout')),10000);});
const raw=await evalp("localStorage.getItem('fufumidi_playlists_v1')");const active=await evalp("localStorage.getItem('fufumidi_active_playlist')");fs.writeFileSync('E:/Midi/_attic/electron-playlists.json',JSON.stringify({raw,active},null,2));console.log('written', raw ? JSON.parse(raw).length : 0, active);
ws.close();child.kill();
