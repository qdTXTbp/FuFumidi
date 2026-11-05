import { spawn } from 'node:child_process';import path from 'node:path';import os from 'node:os';
const ROOT=path.resolve(import.meta.dirname,'..','..');const exe=path.join(ROOT,'node_modules','electron','dist','electron.exe');
const ud=path.join(process.env.APPDATA,'FuFumidi');
console.log('ud',ud, 'exe', exe);
const c=spawn(exe,[ROOT,'--remote-debugging-port=9556','--user-data-dir='+ud],{cwd:ROOT,env:{...process.env,FUFUMIDI_E2E_HIDDEN:'1',FUFUMIDI_E2E_DATA_ROOT:'E:\\Midi\\FuFumidi\\FuFumidiData'},stdio:['ignore','inherit','inherit']});
setTimeout(()=>{console.log('pid',c.pid,'exitCode',c.exitCode);c.kill();},6000);
