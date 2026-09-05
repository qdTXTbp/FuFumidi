// 音色工坊资源预拉取：从可用下载源实际下载 SF2 到 soundfonts-dist/，供「GitHub 建仓镜像」使用。
// 用法：
//   node scripts/fetch-soundfonts.mjs            # 尝试全部
//   node scripts/fetch-soundfonts.mjs generaluser fluidr3   # 只下指定 id
// 目标目录 soundfonts-dist/（已加入 .gitignore，不会污染 FuFumidi 主仓）
import { writeFileSync, mkdirSync, rmSync, existsSync, createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outRoot = path.join(root, 'soundfonts-dist');

const GH = {
  jason: 'https://gh.jasonzeng.dev/https://raw.githubusercontent.com',
  ghfast: 'https://ghfast.top/https://raw.githubusercontent.com',
  ghProxy: 'https://gh-proxy.com/https://raw.githubusercontent.com',
};

const SOURCES = {
  generaluser: {
    file: 'GeneralUser GS v1.471.sf2',
    minSize: 25000000,
    urls: [
      `${GH.jason}/ROCKNIX/generaluser-gs/main/GeneralUser%20GS%20v1.471.sf2`,
      `${GH.ghfast}/ROCKNIX/generaluser-gs/main/GeneralUser%20GS%20v1.471.sf2`,
    ],
  },
  fluidr3: {
    file: 'FluidR3_GM.sf2',
    minSize: 90000000,
    urls: ['https://sourceforge.net/projects/androidframe/files/soundfonts/FluidR3_GM.sf2/download'],
  },
  arachno: {
    file: 'Arachno SoundFont - Version 1.0.sf2',
    minSize: 90000000,
    urls: [
      `https://github.com/rwtnb/Drumsthesia/raw/refs/heads/main/Arachno%20SoundFont%20-%20Version%201.0.sf2`,
    ],
  },
};

async function download(id, spec) {
  const dir = path.join(outRoot, id);
  mkdirSync(dir, { recursive: true });
  const out = path.join(dir, spec.file);
  if (existsSync(out)) {
    const { statSync } = await import('node:fs');
    try { if (statSync(out).size >= spec.minSize) { console.log(`[skip] ${id} 已存在 ${statSync(out).size}`); return { id, ok: true, existed: true }; } } catch (e) {}
  }
  for (const url of spec.urls) {
    console.log(`[get] ${id} ← ${url}`);
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 900000);
      const res = await fetch(url, { headers: { 'user-agent': 'FuFumidi' }, signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok || !res.body) { console.log(`      HTTP ${res.status}，换下一源`); continue; }
      const len = Number(res.headers.get('content-length') || 0);
      const ws = createWriteStream(out + '.part');
      const reader = res.body.getReader();
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        await new Promise((r, j) => ws.write(Buffer.from(value), e => (e ? j(e) : r())));
        if (got % 20000000 < value.length) console.log(`      ${(got / 1048576).toFixed(1)} MB / ${(len / 1048576).toFixed(1)} MB`);
      }
      await new Promise((r, j) => ws.end(e => (e ? j(e) : r())));
      if (got < spec.minSize) { ws.destroy(); rmSync(out + '.part', { force: true }); console.log('      文件不完整 < minSize，换下一源'); continue; }
      rmSync(out, { force: true });
      const { renameSync } = await import('node:fs');
      renameSync(out + '.part', out);
      console.log(`[ok]   ${id} 完成 ${got} bytes -> ${out}`);
      return { id, ok: true, size: got };
    } catch (e) {
      console.log('      ERR ' + (e && (e.message || e)));
      try { rmSync(out + '.part', { force: true }); } catch (e2) {}
    }
  }
  return { id, ok: false };
}

const want = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SOURCES);
for (const id of want) {
  const spec = SOURCES[id];
  if (!spec) { console.log(`未知 id: ${id}`); continue; }
  await download(id, spec);
}
console.log('完成。目录：' + outRoot);