// 界面级繁體复验 · 第 1 步：切到繁體并重载（App.vue 从 localStorage 读语言）。
(() => {
  const prev = localStorage.getItem('fufumidi_lang');
  localStorage.setItem('fufumidi_prev_lang_probe', prev || '');
  localStorage.setItem('fufumidi_lang', 'zh-Hant');
  setTimeout(() => location.reload(), 200);
  return { prevLang: prev, now: 'zh-Hant' };
})()
