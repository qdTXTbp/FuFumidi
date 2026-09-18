(() => {
  const app = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app');
  const G = window.__fufumidiGuide;
  return JSON.stringify({
    lang: localStorage.getItem('fufumidi_lang'),
    settingsOpen: app.ui.settingsOpen,
    settingsTab: app.ui.settingsTab,
    guideOpen: app.ui.guideOpen,
    guideState: G ? G.state() : null,
    dialog: app.dialog ? app.dialog.kind : null,
    toast: app.toastMsg,
    view: app.view,
    hash: location.hash,
    settingsPanel: !!document.querySelector('#settingsPanel'),
    ovTabs: [...document.querySelectorAll('.ov-tab')].map(e => e.textContent.trim()).slice(0, 9),
    appearanceSpans: [...document.querySelectorAll('.ov-tab-body span')].map(e => e.textContent.trim()).filter(s => s.length < 12).slice(0, 14),
  }, null, 1);
})()