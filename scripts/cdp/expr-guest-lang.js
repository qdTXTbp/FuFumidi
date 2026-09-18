// 多语言实机复验（虚拟机 L3）：依次切到 简体 / 繁體 / English / 日本語，
// 每一档都取「设置页签 + 引导目录章节名 + 引导某一步标题说明」三处实际渲染文本，
// 最后恢复原语言。看点：① 四档都有内容、不是空/原始键；② 英日不残留中文；③ 繁體用词被转换。
(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const app = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app');
  const LANGS = [['zh', -2], ['zh-Hant', -1], ['en', 0], ['ja', 1]];   // 相对「English」按钮的位置
  const orig = localStorage.getItem('fufumidi_lang') || 'zh';

  // 语言按钮的字面量本身会被翻译（日语界面下「简体中文」不是这四个字），所以不能靠文案找，
  // 改为：先定位固定不翻译的 English 按钮，再按模板顺序取兄弟节点。
  async function pickLang(off) {
    app.ui.settingsTab = 'appearance';   // 语言开关在「外观」页，不先切页签就找不到它
    app.ui.settingsOpen = true;
    await sleep(700);
    const en = [...document.querySelectorAll('span')].find(s => s.textContent.trim() === 'English');
    const span = en ? en.parentElement.children[Array.prototype.indexOf.call(en.parentElement.children, en) + off] : null;
    if (!span) return false;
    span.click();
    await sleep(900);
    app.ui.settingsOpen = false;
    await sleep(300);
    return true;
  }

  async function sample() {
    app.ui.guideOpen = true;
    await sleep(500);
    const G = window.__fufumidiGuide;
    G.open();
    await sleep(500);
    const names = [...document.querySelectorAll('.cat-item b')].map(e => e.textContent.trim());
    const intro = (document.querySelector('.cat-intro') || {}).textContent || '';
    G.start(0);
    await sleep(1800);
    const title = (document.querySelector('.ig-card .ig-head b') || {}).textContent || '';
    const desc = (document.querySelector('.ig-card .ig-desc') || {}).textContent || '';
    app.ui.guideOpen = false;
    await sleep(200);
    return {
      lang: localStorage.getItem('fufumidi_lang'),
      chapterCount: names.length,
      chapters: names.slice(0, 5),
      introHasCjk: /[\u4e00-\u9fff]/.test(intro),
      stepTitle: title, stepDesc: desc.slice(0, 40),
      descHasCjk: /[\u4e00-\u9fff]/.test(desc),
      descHasKana: /[\u3040-\u30ff]/.test(desc),
      // 原始键泄漏的粗判：整串仍是中文原文即命中（英文档下不该出现）。
      // 注意「UTAU 音MAD」是专有名词，本身带汉字，所以只抽查步骤文案与目录前几章。
      rawKeyLeak: localStorage.getItem('fufumidi_lang') === 'en'
        ? /[\u4e00-\u9fff]/.test(title + desc + names.slice(0, 6).join(''))
        : null,
    };
  }

  const out = {};
  for (const [code, off] of LANGS) {
    const ok = await pickLang(off);
    out[code] = ok ? await sample() : { err: 'language switch target not found' };
  }
  // 恢复
  const back = LANGS.find(l => l[0] === orig);
  if (back) await pickLang(back[1]);
  app.ui.guideOpen = false;
  out.__restored = localStorage.getItem('fufumidi_lang');
  // 经虚拟机反向隧道时，长求值的响应可能被 NAT 丢掉（脚本其实跑完了，只是结果回不来）。
  // 因此把结果挂在 window 上，由下一次短求值取走。
  window.__langProbe = out;
  return 'ok: ' + Object.keys(out).join(',');
})()