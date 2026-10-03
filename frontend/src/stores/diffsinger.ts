// Pinia：DiffSinger 调教工作台共享状态
// 语义：一个 DiffSinger 工程 = 选定的声库 + 音符序列（音高/歌词/时长，拍制坐标）
//       + BPM + 调教参数（颤音/音分偏移）。模块未启用时本 store 只保留只读状态。
import { defineStore } from 'pinia';
import { bridge, isDesktop } from '../api';
import { parseMidi, buildSong } from '../core/midi.js';
import type { DiffsingerLyricSuggestion } from '../types/ipc';

export interface DsNote {
  id: string;
  startBeat: number;   // 起点（拍，四分音符=1）
  durBeat: number;     // 时长（拍）
  pitch: number;       // MIDI 音高号（60=C4）
  lyric: string;       // 歌词（查声库词典 / 音素）
  vibrato: boolean;
  vibDepth: number;    // 颤音深度（音分）
  vibFreq: number;     // 颤音频率 Hz
  vibFade: number;     // 颤音渐入（ms）
  pitchOffset: number; // 音分偏移 -100..100
}

export const DS_NOTE_DEFAULTS = { vibrato: false, vibDepth: 25, vibFreq: 5.5, vibFade: 0, pitchOffset: 0 };

/** 撤销快照：音符列表 + 选区 + 音高曲线（可视化谱面用）。DsNote 是扁平结构，浅拷贝逐项即可。 */


/* 从曲库曲目读取 MIDI 字节：内存缓存 → IndexedDB → 磁盘镜像 */
async function readSongBytes(song: any): Promise<Uint8Array | null> {
  if (!song) return null;
  if (song.__bytes) return song.__bytes;
  try {
    const req = indexedDB.open('fufumidi-db', 1);
    const db: any = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
    const row: any = await new Promise((res) => {
      try {
        const rq = db.transaction('songs', 'readonly').objectStore('songs').get(song.id);
        rq.onsuccess = () => res(rq.result || null);
        rq.onerror = () => res(null);
      } catch (e) { res(null); }
    });
    if (row && row.bytes) return new Uint8Array(row.bytes);
  } catch (e) {}
  if (isDesktop && bridge && typeof bridge.readBinary === 'function' && song.meta && song.meta.path) {
    try {
      const r = await bridge.readBinary(song.meta.path);
      if (r && r.ok && r.bytes) return new Uint8Array(r.bytes as any);
    } catch (e) {}
  }
  return null;
}

/* IndexedDB 打开（与 app store 同库同表结构） */

// 最近一次渲染的 WAV 字节（不进响应式状态，供「导出 WAV」使用）
let _lastWavBytes: Uint8Array | null = null;
export function getLastWavBytes(): Uint8Array | null { return _lastWavBytes; }

export const useDiffsingerStore = defineStore('diffsinger', {
  state: () => ({
    /* 模块状态（主进程为准） */
    enabled: true,   // ★ 默认启用：不再要求用户先手动点「启用模块」
    ready: false,
    depsOk: false,
    depsMissing: [] as string[],
    depsError: '',
    depsSkipped: false,
    vocoderInstalled: false,
    vocoderDir: '',
    checking: false,

    /* 组件安装 */
    runtimeInstalling: false,
    runtimePct: 0,
    runtimeText: '',
    runtimeError: '',

    /* 声库 */
    voicebanks: [] as { name: string; dir: string; size?: number }[],
    registry: [] as any[],
    vbProgress: {} as Record<string, { percent: number; phase?: string; done?: boolean; error?: string; speed?: number; received?: number; total?: number; host?: string; text?: string; canceled?: boolean }>,
    voicebankInfo: null as any,
    inspecting: false,

    /* 工程 */
    /** ★ 轨道级语言（照搬新版上游 USingerTrack.Language）。
     *  OpenUtau 是在轨道上选歌手语言的，**不从歌词自动判断** ——
     *  多语言声库（en/ja/ko/zh）用哪套词典由此决定。 */

    /* 渲染 */

    /* 范围渲染预览 —— 只合成选区内音符（可带前后文） */
    /** 上次范围渲染返回的选区元信息（秒） */
    /** 上次渲染使用的推理链路与后端 */
    /** 推理后端偏好：auto / cpu / cuda / dml */
    /** 推理后端信息（来自 status.gpu） */
    gpu: null as any,
  }),
  getters: {
    hasBridge(): boolean {
      return isDesktop && !!bridge && typeof (bridge as any).diffsingerStatus === 'function';
    },
  },
  actions: {
    /* ---------------- 持久化 ---------------- */
    // ★ 歌曲数据（bpm / notes / 声库 / 音高曲线）已迁到 `stores/singer.ts`，
    //   本 store 只持模块状态，不再落盘工程内容。
    persist() { /* 模块状态由主进程 status 权威，无需本地缓存 */ },
    init() { /* no-op：保留调用点，避免宿主初始化顺序变化 */ },


    /** force=true 跳过主进程 30s 依赖缓存强制重探（GPU 增强包安装/卸载后调用） */
    async loadStatus(force = false) {
      if (!this.hasBridge) return;
      this.checking = true;
      try {
        const s = await (bridge as any).diffsingerStatus(force ? { force: true } : undefined);
        if (s && s.ok) {
          this.enabled = !!s.enabled;
          this.ready = !!s.ready;
          this.depsOk = !!(s.deps && s.deps.ok);
          this.depsMissing = (s.deps && s.deps.missing) || [];
          this.depsError = (s.deps && s.deps.error) || '';
          this.depsSkipped = !!(s.deps && s.deps.skipped);
          this.vocoderInstalled = !!(s.vocoder && s.vocoder.installed);
          this.vocoderDir = (s.vocoder && s.vocoder.dir) || '';
          this.gpu = s.gpu || null;
        }
      } catch (e) {}
      this.checking = false;
    },
    async setEnabled(on: boolean): Promise<string> {
      if (!this.hasBridge) return '桌面版不可用';
      const r = await (bridge as any).diffsingerSetEnabled(!!on);
      if (r && r.ok) {
        this.enabled = !!r.enabled;
        await this.loadStatus();
        return '';
      }
      return (r && r.error) || '操作失败';
    },

    /* ---------------- 组件安装（启用后才允许） ---------------- */
    async installRuntime(): Promise<string> {
      if (!this.hasBridge) return '桌面版不可用';
      if (this.runtimeInstalling) return '组件安装已在进行中';
      this.runtimeInstalling = true;
      this.runtimePct = 0;
      this.runtimeText = '';
      this.runtimeError = '';
      let off = () => {};
      try {
        off = (bridge as any).onDiffsingerRuntimeProgress((p: any) => {
          if (!p) return;
          if (typeof p.percent === 'number' && p.percent >= 0) this.runtimePct = p.percent;
          if (p.text) this.runtimeText = String(p.text);
          if (p.phase === 'error') this.runtimeError = p.text || '安装失败';
        });
        const r = await (bridge as any).diffsingerInstallRuntime();
        if (r && r.ok) {
          await this.loadStatus();
          return '';
        }
        return (r && r.error) || '安装失败';
      } catch (e) {
        return String((e as any) && (e as any).message || e);
      } finally {
        off();
        this.runtimeInstalling = false;
      }
    },
    async cancelRuntimeInstall() {
      if (this.hasBridge) { try { await (bridge as any).diffsingerCancelRuntimeInstall(); } catch (e) {} }
      this.runtimeInstalling = false;
    },
    async uninstallRuntime(alsoVoicebanks: boolean): Promise<string> {
      if (!this.hasBridge) return '桌面版不可用';
      const r = await (bridge as any).diffsingerUninstallRuntime({ alsoVoicebanks });
      if (r && r.ok) { await this.loadStatus(); await this.refreshVoicebanks(); return ''; }
      return (r && r.error) || '清理失败';
    },

    /* ---------------- 声库管理 ---------------- */
    async refreshVoicebanks() {
      if (!this.hasBridge) return;
      try {
        const r = await (bridge as any).diffsingerListVoicebanks();
        // ★ 只维护「已装列表」——「当前用哪个声库」是**轨道**的事（`singer.ts`），
        //   本 store 不再持有 selected 语义。
        this.voicebanks = (r && r.list) || [];
      } catch (e) {}
    },
    async refreshRegistry() {
      if (!this.hasBridge) return;
      try {
        const r = await (bridge as any).diffsingerVoicebankRegistry();
        this.registry = (r && r.list) || [];
      } catch (e) {}
    },
    async importZip(): Promise<string> {
      if (!this.hasBridge) return '桌面版不可用';
      const r = await (bridge as any).diffsingerImportVoicebankZip();
      if (r && r.ok) { await this.loadStatus(); await this.refreshVoicebanks(); return ''; }
      if (r && r.canceled) return '';
      return (r && r.error) || '导入失败';
    },
    async importZipFromPath(p: string): Promise<string> {
      if (!this.hasBridge) return '桌面版不可用';
      const r = await (bridge as any).diffsingerImportVoicebankZip(p);
      if (r && r.ok) { await this.loadStatus(); await this.refreshVoicebanks(); return ''; }
      return (r && r.error) || '导入失败';
    },
    async deleteVoicebank(dir: string): Promise<string> {
      if (!this.hasBridge) return '桌面版不可用';
      const r = await (bridge as any).diffsingerDeleteVoicebank(dir);
      if (r && r.ok) { await this.refreshVoicebanks(); return ''; }
      return (r && r.error) || '删除失败';
    },
    async downloadVoicebank(id: string): Promise<string> {
      if (!this.hasBridge) return '桌面版不可用';
      let off = () => {};
      this.vbProgress = { ...this.vbProgress, [id]: { percent: 0, phase: 'download' } };
      try {
        off = (bridge as any).onDiffsingerVoicebankProgress((p: any) => {
          if (!p || p.id !== id) return;
          this.vbProgress = {
            ...this.vbProgress,
            [id]: {
              percent: p.percent || 0, phase: p.phase, done: p.done, error: p.error || '',
              speed: Number(p.speed) || 0, received: Number(p.received) || 0,
              total: Number(p.total) || 0, host: p.host || '', text: p.text || '', canceled: !!p.canceled,
            },
          };
        });
        const r = await (bridge as any).diffsingerDownloadVoicebank(id);
        if (r && r.ok) { await this.refreshVoicebanks(); return ''; }
        if (r && r.canceled) return '';   // 用户主动取消：不是错误，不弹失败提示
        return (r && r.error) || '下载失败';
      } catch (e) {
        return String((e as any) && (e as any).message || e);
      } finally {
        off();
      }
    },
    async cancelVoicebankDownload(id: string) {
      if (this.hasBridge) { try { await (bridge as any).diffsingerCancelVoicebankDownload(id); } catch (e) {} }
      this.vbProgress = { ...this.vbProgress, [id]: { percent: 0, phase: 'done', done: true } };
    },
    /** 解析一个声库（目录由调用方给 —— 原来读 `this.voicebankDir`）。 */
    async inspect(dir: string): Promise<string> {
      if (!this.hasBridge || !dir) { this.voicebankInfo = null; return ''; }
      this.inspecting = true;
      try {
        const r = await (bridge as any).diffsingerInspectVoicebank({ voicebank: dir });
        this.voicebankInfo = r && r.ok ? r : null;
        return (r && r.ok) ? '' : ((r && r.error) || '声库解析失败');
      } catch (e) {
        this.voicebankInfo = null;
        return String((e as any) && (e as any).message || e);
      } finally {
        this.inspecting = false;
      }
    },
    /** 导入基底旋律（从曲库 MIDI）：replace=true 先清空现有音符 */
    /** 正在取候选的歌词（null = 无输入框激活） */
    suggestFor: null as null | { id: string; text: string },
    suggestItems: [] as DiffsingerLyricSuggestion[],
    suggestOpen: false,
    /** 请求候选。`language` 取**轨道级**设置，不是从歌词猜的。 */
    /** 点选候选 → 写进该音符的歌词 */


    /** 在每次会改变音符的操作**之前**调用，压入当前快照 */

    /** primary 传 null 时保留当前主选（若仍在选区内），否则取第一个 */

    /** 按相对量平移：起点与音高同时变化（多选整体拖动） */
    /** 按绝对量设置时长（右缘拖拽；多选取新的统一时长） */

    /**
     * 从曲库曲目导入 MIDI：解析全部轨道，返回轨道摘要供 UI 选择；
     * 选定后由 applyMidiTrack 落音符。失败返回错误字符串。
     */
    /** 把选中轨道的音符落进工程（tick → 拍） */

    /** 把选区设为「某个音符」或「全部音符」的便捷入口 */
  },
});
