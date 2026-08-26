// 精简 i18n：与 legacy 使用相同词表结构（中文为源文案，英文为翻译）
// 仅抽取 UI 外壳/播放条/核心视图用到的词条；完整词表仍在 legacy FuFumidi.html。

export const I18N_MAP = {
  /* 侧边栏 */
  '导入 MIDI': 'Import MIDI',
  '我的资料库': 'My Library',
  '转录': 'Transcribe',
  '设置': 'Settings',
  '关于': 'About',
  '音轨 ': 'Track ',
  '清空': 'Clear',
  '播放器': 'Player',
  '播放列表': 'Playlist',
  '空': 'Empty',
  /* 播放条 */
  '播放': 'Play',
  '暂停': 'Pause',
  '停止': 'Stop',
  '上一首': 'Previous',
  '下一首': 'Next',
  '循环': 'Loop',
  '音量': 'Volume',
  '节拍器': 'Metronome',
  /* 通用 */
  '确定': 'OK',
  '取消': 'Cancel',
  '关闭': 'Close',
  '保存': 'Save',
  '删除': 'Delete',
  '正在加载': 'Loading…',
  '未选择文件': 'No file selected',
  '文件过短，不是有效的 MIDI': 'File too short, not a valid MIDI',
  '不是有效的 MIDI 文件（缺少 MThd 头）': 'Not a valid MIDI file (missing MThd header)',
  '暂不支持 SMPTE 时间码的 MIDI（请转换后重试）': 'SMPTE timecode MIDI is not supported',
  'MIDI 轨道数异常（': 'Abnormal MIDI track count (',
  '），拒绝解析': '), refused to parse',
  '轨道块损坏': 'Track chunk corrupted',
  '无': 'None',
  '全部': 'All',
  '搜索': 'Search',
  '导入文件夹': 'Import folder',
  '重命名': 'Rename',
  '导出 MIDI': 'Export MIDI',
  '速度': 'Speed',
  '音色': 'Timbre',
  '延音踏板': 'Sustain',
  '已暂停': 'Paused',
};

let LANG = 'zh'; // 'zh' | 'en'

export function setLang(v) { LANG = v === 'en' ? 'en' : 'zh'; }
export function getLang() { return LANG; }

export function t(str) {
  if (LANG !== 'en') return str;
  return I18N_MAP[str] || str;
}
