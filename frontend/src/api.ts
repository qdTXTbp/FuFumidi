// ============================================================
// 类型化 API 封装：前端统一从这里访问 preload 桥，而不是直接摸 window.fuBridge
// 后续可以替换为 JSON-RPC / WebSocket 而不改动组件
// ============================================================

import type { FuBridge } from './types/ipc';

export const bridge = (window as any).fuBridge as FuBridge | undefined;

export const isDesktop = !!bridge?.convert;

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
