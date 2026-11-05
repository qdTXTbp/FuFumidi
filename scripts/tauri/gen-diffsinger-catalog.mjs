import { createRequire } from 'node:module';import fs from 'node:fs';
const require=createRequire(import.meta.url);const c=require('../../main/diffsinger-ms-catalog.js');
fs.writeFileSync(new URL('../../frontend/public/diffsinger-ms-catalog.json',import.meta.url),JSON.stringify({ok:true,license:'CC-BY-NC-4.0',stats:c.STATS,works:c.WORKS}));
console.log('works',c.WORKS.length,'stats',JSON.stringify(c.STATS).slice(0,120));