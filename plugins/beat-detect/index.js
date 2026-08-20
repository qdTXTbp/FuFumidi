module.exports = {
  activate(ctx) {
    ctx.log('节拍检测插件已激活');
    ctx.commands.register('beatDetectHelp', async () => {
      const meta = ctx.app.getSongMeta();
      return '节拍检测插件：可在插件页扩展为音频 BPM 检测。当前歌曲 BPM：' + (meta && meta.bpm != null ? meta.bpm : '未知');
    });
  },
  deactivate() {}
};
