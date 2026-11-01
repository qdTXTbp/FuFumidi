# FuFumidi 6.5.0（开发中）

## 智能分轨转录

- 固定 6-stem 分轨（HTDemucs4_6stems）。
- 六角色：人声 / 鼓 / 贝斯 / 钢琴 / 吉他 / 其他。
- 每轨固定 GM 音色，删除轨内 program_change，解决音色乱跳。
- 轨道预算：自动 / 6 / 12 / 16 / 全部候选。
- 30+ 轨工程保留，MIDI 导出分组。

## 3D 互动钢琴

- 3D 钢琴、下落音符、自由演奏、跟弹、音游、录制。
- 外接 USB/蓝牙 MIDI 键盘。
- 复用现有 midiin.js / recorder.js / RecordPanel。

## 修复

- 自动更新按当前运行安装目录更新（-D）。
- 恢复冷启动 splash。
