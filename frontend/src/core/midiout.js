// Web MIDI 硬件输出（基础版：系统首个 MIDI 输出设备）
// 与合成器播放协调：由 PlayerBar 挂接 Player.onNote / onStop 回调驱动
let midiOut = null;
let enabled = false;

export function isMidiOutEnabled() { return enabled; }
export function setMidiOutEnabled(b) { enabled = b; }
export function getMidiOutDeviceName() { return midiOut ? (midiOut.name || 'MIDI 输出') : ''; }

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
// 暂停/停止时立即关闭所有音符（CC123 All Notes Off）
export function midiAllOff() {
  if (!midiOut) return;
  try { midiOut.send([0xb0, 123, 0]); } catch (e) {}
}
