// ============================================================
// 类型化 API 封装：前端统一从这里访问 preload 桥，而不是直接摸 window.fuBridge
// 后续可以替换为 JSON-RPC / WebSocket 而不改动组件
// ============================================================

import type { FuBridge } from './types/ipc';

// ★ 必须是 live binding：Tauri 桥在页面初始化后段才注入，本模块可能先被求值。
//   若用 const 捕获，api.bridge 会永久 undefined（曲库/设置全读不到），所以由 refreshBridge() 更新。
export let bridge = (window as any).fuBridge as FuBridge | undefined;

export let isDesktop = !!bridge?.convert;

/** 桥注入/重建后调用，刷新所有 import { bridge } 模块看到的 live binding。 */
export function refreshBridge() {
  bridge = (window as any).fuBridge as FuBridge | undefined;
  isDesktop = !!bridge?.convert;
  try { (window as any).__apiBridgeReady = !!bridge; (window as any).__apiBridgeKeys = bridge ? Object.keys(bridge).length : 0; } catch (e) {}
}

export const fuApi = bridge || ({} as FuBridge);

export type { FuBridge } from './types/ipc';
export type {
  ConvertRequest,
  ConvertResult,
  RefineRequest,
  RefineResult,
  GpuKind,
  GpuPackage,
  GpuStatusResult,
  GeneralResult,
  PresetItem,
  PluginInfo,
  Settings,
  RustStatusResult,
  RustInvokeResult,
  DbStatusResult,
  DbSongItem,
  WallpaperItem,
  WallpaperListResult,
  WallpaperDownloadResult,
} from './types/ipc';
