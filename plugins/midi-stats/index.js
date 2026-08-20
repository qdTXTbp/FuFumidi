module.exports = {
  activate(ctx) {
    ctx.log('MIDI 统计插件已激活');
    ctx.commands.register('midiStats', async () => {
      const meta = ctx.app.getSongMeta();
      if (!meta || !meta.fileName) return '当前未载入歌曲';
      return 'MIDI 统计：' + meta.fileName + ' · ' + meta.trackCount + ' 轨 · ' + meta.totalTicks + ' tick' +
        (meta.bpm != null ? ' · ' + meta.bpm + ' BPM' : '');
    });
  },
  deactivate() {}
};
