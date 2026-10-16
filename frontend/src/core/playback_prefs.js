// ============================================================
// 播放偏好（跳过空白 / 方向键步长 / 长按倍数）—— 单一来源。
//
// 为什么不塞进 store.js：store 管的是"当前歌曲的状态"，这些是"用户偏好"，
// 而且 App.vue（键盘）、PlayerBar.vue（开关）、SettingsPanel.vue（设置页）、
// store.js（装载/播放时应用）四处都要读它 —— 放一个不依赖 Pinia 的小模块最省事，
// 也让 core/ 里的纯函数与播放器能直接 import。
//
// 持久化仍然走主进程 settings.json（bridge.getSettings / saveSettings）。
// 用户 2026-10-14 定：跳过空白**默认关**（但给显眼开关）；**开头静音默认跳**。
// ============================================================
import { reactive } from "vue";

export const playbackPrefs = reactive({
  skipSilence: false,          // 播放时跳过没有音符的空档
  skipSilenceMin: 2.5,         // 多长的空档才跳（秒）
  skipSilenceLead: 0.2,        // 落到空档末尾前留多少余量（秒）
  skipLeadingSilence: true,    // 开头静音默认跳
  seekStep: 5,                 // 方向键步长
  seekStepUnit: "sec",         // sec | percent | bar
  holdDelayMs: 400,            // 按住多久算长按
  holdRate: 2,                 // 长按时的播放倍数
});

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

/** 从设置对象读入（缺项保持默认）。返回是否发生了变化。*/
export function applyPlaybackSettings(s) {
  if (!s) return false;
  const before = JSON.stringify(playbackPrefs);
  if (s.skip_silence !== undefined) playbackPrefs.skipSilence = !!s.skip_silence;
  if (s.skip_silence_min !== undefined) playbackPrefs.skipSilenceMin = num(s.skip_silence_min, 2.5);
  if (s.skip_leading_silence !== undefined) playbackPrefs.skipLeadingSilence = !!s.skip_leading_silence;
  if (s.seek_step !== undefined) playbackPrefs.seekStep = num(s.seek_step, 5);
  if (s.seek_step_unit !== undefined && ["sec", "percent", "bar"].includes(s.seek_step_unit)) {
    playbackPrefs.seekStepUnit = s.seek_step_unit;
  }
  if (s.hold_delay_ms !== undefined) playbackPrefs.holdDelayMs = num(s.hold_delay_ms, 400);
  if (s.hold_rate !== undefined) playbackPrefs.holdRate = num(s.hold_rate, 2);
  return before !== JSON.stringify(playbackPrefs);
}

/** 写回主进程用的补丁对象。*/
export function playbackSettingsPatch() {
  return {
    skip_silence: playbackPrefs.skipSilence,
    skip_silence_min: playbackPrefs.skipSilenceMin,
    skip_leading_silence: playbackPrefs.skipLeadingSilence,
    seek_step: playbackPrefs.seekStep,
    seek_step_unit: playbackPrefs.seekStepUnit,
    hold_delay_ms: playbackPrefs.holdDelayMs,
    hold_rate: playbackPrefs.holdRate,
  };
}
