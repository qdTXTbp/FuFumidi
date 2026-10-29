// 简易焦点陷阱：让弹窗打开后将 Tab 循环限制在弹窗内部
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export const vFocusTrap = {
  mounted(el) {
    if (!el || el.dataset.focusTrap === '1') return;
    el.dataset.focusTrap = '1';
    const onKey = (e) => {
      if (e.key !== 'Tab') return;
      const els = Array.from(el.querySelectorAll(FOCUSABLE))
        .filter(x => x.offsetParent !== null || x === document.activeElement);
      if (!els.length) return;
      const first = els[0];
      const last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    el.addEventListener('keydown', onKey);
    el._focusTrapCleanup = () => el.removeEventListener('keydown', onKey);
    // 关闭后把焦点还给「打开它的那个控件」：否则焦点落在被移除的节点上，
    // 浏览器把焦点丢回 body，键盘用户要重新 Tab 走一整套界面才能回到原处。
    try { el._focusTrapPrev = document.activeElement; } catch (e) { el._focusTrapPrev = null; }
    requestAnimationFrame(() => {
      if (!el.contains(document.activeElement)) {
        const first = el.querySelector(FOCUSABLE);
        if (first) first.focus();
      }
    });
  },
  unmounted(el) {
    if (el._focusTrapCleanup) el._focusTrapCleanup();
    try {
      const prev = el._focusTrapPrev;
      if (prev && prev !== document.body && prev.isConnected && typeof prev.focus === 'function') prev.focus();
    } catch (e) { /* 打开者已不在文档里（切视图等），不强行找落点 */ }
  },
};
