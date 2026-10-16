// 右键菜单的落点计算（用户 2026-10-14 报：「右键菜单过长超出工具窗口，底部项点不到」）。
//
// 旧写法是**猜一个高度**：ViewEdit 里 CTX_H = 402、SideBar 里 SONG_MENU_H = 246、
// 歌单菜单 min(130, …)。钢琴卷帘与调教页的轨道菜单干脆不夹。
// 现实是这些菜单会随项数 / 字号 / 界面密度 / 语言变化 —— 实测编辑页那个菜单真实高度约
// 780px（26 项 + 分隔线），按 402 去夹，只要在窗口下半部右键，底部就有约 380px 落到窗口
// 外面，永远点不到。
//
// 现在统一：**显示后量真实尺寸**再夹；菜单自身的 max-height/overflow 由各自 CSS 兜底
// （见 .ctx-menu / .pr-ctx / .tk-menu / .pl-ctx-menu 的 max-height: calc(100vh - 16px)）。

export const MENU_PAD = 8;

/** 把 (x, y) 夹到「以 (ox, oy) 为原点、宽 w 高 h 的可用区」里，保证整个菜单都在区内。
 *  bounds 省略时按整个窗口算（fixed 定位的菜单用这个）。 */
export function clampMenu(x, y, menuW, menuH, bounds) {
  const ox = (bounds && bounds.left) || 0;
  const oy = (bounds && bounds.top) || 0;
  const bw = (bounds && bounds.width) || (typeof window !== "undefined" ? window.innerWidth : 0);
  const bh = (bounds && bounds.height) || (typeof window !== "undefined" ? window.innerHeight : 0);
  const maxX = ox + bw - menuW - MENU_PAD;
  const maxY = oy + bh - menuH - MENU_PAD;
  return {
    left: Math.max(ox + MENU_PAD, Math.min(x, Math.max(ox + MENU_PAD, maxX))),
    top: Math.max(oy + MENU_PAD, Math.min(y, Math.max(oy + MENU_PAD, maxY))),
  };
}

/** 量一个已经渲染出来的菜单元素，返回夹好的 { left, top }（菜单不可用时返回 null）。
 *  bounds 传容器矩形（absolute 菜单，坐标是容器内坐标）；不传 = 视口坐标（fixed 菜单）。 */
export function fitMenu(el, x, y, bounds) {
  if (!el || typeof el.getBoundingClientRect !== "function") return null;
  const w = el.offsetWidth || el.getBoundingClientRect().width || 0;
  const h = el.offsetHeight || el.getBoundingClientRect().height || 0;
  if (!w || !h) return null;
  return clampMenu(x, y, w, h, bounds);
}

/** 菜单是否高过可用区（高过就必须能滚，否则底部永远点不到）。 */
export function menuTooTall(el, availH) {
  if (!el || !availH) return false;
  return (el.scrollHeight || el.offsetHeight || 0) > availH;
}