// 在任何 store/api 模块求值前注入 Tauri 桥。
// 原因：api.ts 在模块加载时捕获 window.fuBridge；若等到 main.ts 里 mount 前才安装，
// api.bridge 会永久是 undefined（Tauri 版曲库恢复读不到 dbSongsList → 显示 0 首）。
// 本模块必须作为 main.ts 的**第一个** import，利用 ESM 依赖求值顺序先装桥。
import { installTauriBridge } from './tauri';
import { refreshBridge } from '../api';

installTauriBridge();
refreshBridge();
