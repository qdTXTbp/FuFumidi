// Web MIDI 硬件输出（基础版：系统首个 MIDI 输出设备）
// 与合成器播放协调：由 PlayerBar 挂接 Player.onNote / onStop 回调驱动
import { t } from './i18n.js';

let midiOut = null;
let enabled = false;

export function isMidiOutEnabled() { return enabled; }
export function setMidiOutEnabled(b) { enabled = b; }
export function getMidiOutDeviceName() { return midiOut ? (midiOut.name || t('MIDI 输出')) : ''; }

export async function initMidiOutput() {
  if (!navigator.requestMIDIAccess) return false;
  try {
    const acc = await navigator.requestMIDIAccess();
    const out = Array.from(acc.outputs.values()).find(o => o);
    if (!out) return false;
    midiOut = out;
    return true;
  } catch (e) { return false; }
}

// audioTime 为 Web Audio 时钟秒（ctx.currentTime 时间轴），audioNow 为当前 audio 时钟秒
export function midiOutOn(ch, key, vel, audioTime, audioNow) {
  if (!enabled || !midiOut) return;
  const delay = Math.max(0, (audioTime - (audioNow || 0)) * 1000);
  try { midiOut.send([0x90 | (ch & 15), key & 0x7f, vel & 0x7f], performance.now() + delay); } catch (e) {}
}
export function midiOutOff(ch, key, audioTime, audioNow) {
  if (!enabled || !midiOut) return;
  const delay = Math.max(0, (audioTime - (audioNow || 0)) * 1000);
  try { midiOut.send([0x80 | (ch & 15), key & 0x7f, 64], performance.now() + delay); } catch (e) {}
}
// 暂停/停止时立即关闭所有音符。
// ★ 必须遍历全部 16 个通道：旧实现只发 ch0，多通道 MIDI（钢琴 ch0 / 弦乐 ch1…）
//   在暂停后其余通道的音符不会收到 All Notes Off —— 外接音源上就是「某个音一直响不停」。
//   同时复位踏板（CC64/65/66），否则音源内部的 sustain 会把后续音符继续挂住。
export function midiAllOff() {
  if (!midiOut) return;
  for (let ch = 0; ch < 16; ch++) {
    for (const cc of [64, 65, 66, 123, 120]) {
      try { midiOut.send([0xb0 | ch, cc, 0]); } catch (e) {}
    }
  }
}
