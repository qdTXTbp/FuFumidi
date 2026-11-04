// 静态审计：每个 #[tauri::command] 定义都必须出现在 generate_handler![] 里。
// 少了不会编译报错，只会在运行时 "command not found"；rvc_catalog/model_delete 都踩过。
import fs from 'node:fs';

const file = process.argv[2] || 'shells/tauri/src/main.rs';
const src = fs.readFileSync(file, 'utf8');
const defs = [...src.matchAll(/#\[tauri::command\]\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)/g)].map((m) => m[1]);
const handlerBlock = (src.match(/generate_handler!\[([\s\S]*?)\]/) || [null, ''])[1];
const registered = new Set([...handlerBlock.matchAll(/[A-Za-z0-9_]+/g)].map((m) => m[0]));
const missing = [...new Set(defs.filter((d) => !registered.has(d)))].sort();
const extra = [...registered].filter((n) => !defs.includes(n)).sort();
console.log(JSON.stringify({ commands: defs.length, handlerEntries: registered.size, missing, extra }, null, 2));
if (missing.length) { console.error('未注册的 tauri command: ' + missing.join(', ')); process.exit(1); }
