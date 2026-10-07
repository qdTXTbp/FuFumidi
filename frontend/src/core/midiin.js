// Web MIDI 硬件输入（录音：把弹的音变成工程里的音符）
// 与 midiout.js（硬件输出，播放驱动）对称：设备枚举/选择 + noteon/noteoff 回调。
//
// ★ 浏览器安全模型：requestMIDIAccess 在 Electron 里直接放行；普通网页首次
//   会弹权限框。枚举不到设备时调用方展示空列表即可（不报错——没插键盘是常态）。

let access = null;
let activeInput = null;
let _onNoteOn = null;
let _onNoteOff = null;

/** 当前选中的输入设备 id（持久化由调用方做，这里只管会话内的切换） */
let chosenId = '';

export function midiInSupported() { return !!(navigator.requestMIDIAccess); }

/**
 * 解析 MIDI 短消息 → 音符事件（可测纯函数）。
 *
 * Note On（0x90）vel>0 → 'on'；Note Off（0x80）或 Note On vel=0（**另一种
 * 常见 Note Off 编码**，不少键盘只发这种）→ 'off'；其它（CC/PP 等）→ null。
 *
 * @param {Uint8Array|number[]} data  [status, d1, (d2)]
 * @returns {'on'|'off'|null}
 */
export function parseNoteMessage(data) {
  if (!data || data.length < 2) return null;
  const st = data[0] & 0xf0;
  if (st === 0x90 && data[2] > 0) return 'on';
  if (st === 0x80) return 'off';
  if (st === 0x90 && data[2] === 0) return 'off';
  return null;
}

/** 初始化（请求权限）并枚举输入设备。失败返回空数组（没键盘是常态，不算错）。 */
export async function listMidiInputs() {
  if (!navigator.requestMIDIAccess) return [];
  try {
    if (!access) access = await navigator.requestMIDIAccess();
    return Array.from(access.inputs.values()).map(d => ({
      id: d.id, name: d.name || d.id,
    }));
  } catch (e) { return []; }
}

/**
 * 选择输入设备并开始监听（重复调用 = 切换设备；传空 id = 停止监听）。
 * @param {string} id
 * @param {{onNoteOn?: (note: number, vel: number) => void,
 *          onNoteOff?: (note: number) => void}} handlers
 */
export async function selectMidiInput(id, handlers) {
  chosenId = id || '';
  _onNoteOn = (handlers && handlers.onNoteOn) || null;
  _onNoteOff = (handlers && handlers.onNoteOff) || null;
  if (!access) {
    try { if (navigator.requestMIDIAccess) access = await navigator.requestMIDIAccess(); } catch (e) { return false; }
  }
  if (!access) return false;
  if (activeInput) {
    try { activeInput.onmidimessage = null; } catch (e) {}
    activeInput = null;
  }
  if (!chosenId) return true;                                   // 显式停监听
  const input = access.inputs.get(chosenId);
  if (!input) return false;
  activeInput = input;
  input.onmidimessage = (msg) => {
    const d = (msg && msg.data) || null;
    const ev = parseNoteMessage(d);
    if (ev === 'on') { if (_onNoteOn) _onNoteOn(d[1] & 0x7f, d[2] & 0x7f); }
    else if (ev === 'off') { if (_onNoteOff) _onNoteOff(d[1] & 0x7f); }
  };
  return true;
}

/** 状态诊断（UI 提示用） */
export function midiInDeviceName() {
  if (!activeInput) return '';
  try { return activeInput.name || ''; } catch (e) { return ''; }
}
