// ============================================================
// example-hello 插件入口（主进程）
// 演示 ctx 提供的 API：commands / events / settings / ui / log / app
// ============================================================
module.exports = {
  activate(ctx) {
    ctx.log('示例插件已激活');

    // 1) 注册命令：渲染层设置「插件」页会列出 commands，点击即调用
    ctx.commands.register('hello', async () => {
      return '你好，来自插件 ' + ctx.manifest.name + ' v' + ctx.manifest.version;
    });

    ctx.commands.register('songInfo', async () => {
      const meta = ctx.app.getSongMeta();
      if (!meta || !meta.fileName) return '当前未载入歌曲';
      return '当前歌曲：' + meta.fileName +
        '（' + meta.trackCount + ' 轨 · ' + meta.totalTicks + ' tick · ' +
        (meta.bpm != null ? meta.bpm + ' BPM' : '') + '）';
    });

    // 2) 事件监听：载入歌曲 / 切换视图 / 转录完成 / 修正完成
    ctx.events.on('song-loaded', (m) => {
      ctx.log('歌曲已载入：' + (m && m.fileName));
      ctx.ui.notify('插件已同步：新歌曲「' + (m && m.fileName || '未知') + '」', 'ok');
    });
    ctx.events.on('view-changed', (v) => ctx.log('视图切换：' + v));
    ctx.events.on('transcribe-done', (r) => ctx.log('转录完成：' + (r && r.out)));
    ctx.events.on('refine-done', (r) => ctx.log('修正完成：' + (r && r.out)));

    // 3) 插件私有设置：写入 settings.plugins['example-hello']
    const saved = ctx.settings.get('greet');
    ctx.log(saved ? '上次问候语：' + saved : '尚无自定义问候语');
    ctx.settings.set('greet', '你好 ' + new Date().getHours() + ' 点');
  },

  deactivate() {
    // 卸载清理（可选）
  },
};
