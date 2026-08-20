module.exports = {
  activate(ctx) {
    ctx.log('批量重命名插件已激活');
    ctx.commands.register('batchRenameHelp', async () => {
      const meta = ctx.app.getSongMeta();
      return '批量重命名插件：可在插件页扩展为按规则重命名导出文件。当前歌曲：' + (meta && meta.fileName || '未载入');
    });
  },
  deactivate() {}
};
