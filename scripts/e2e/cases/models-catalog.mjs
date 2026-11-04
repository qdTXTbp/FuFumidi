// E2E：现有模型注册表硬约束 R-014 —— 家族齐全、ID 唯一、字段完整。
// 不要求模型已下载（CI/干净数据根 exists=false 是正常的），只防止"悄悄删模型/改 ID/改 kind"。
export default async function (app) {
  await app.waitFor('!!(window.fuBridge && window.fuBridge.modelList)', { timeout: 30000, message: 'modelList 桥' });
  const list = JSON.parse(await app.eval('(async () => JSON.stringify(await window.fuBridge.modelList()))()'));
  app.assert(Array.isArray(list) && list.length >= 80, '模型条目 >= 80，实际 ' + (list ? list.length : 0));
  const ids = list.map((m) => String(m && m.id || ''));
  app.assert(ids.every(Boolean), '每个模型都有 id');
  app.assert(new Set(ids).size === ids.length, '模型 id 唯一');
  app.assert(list.every((m) => m && m.kind && m.name), '每个模型都有 kind/name');

  const blob = list.map((m) => [m.id, m.kind, m.name, m.outName].join(' ').toLowerCase()).join('\n');
  const has = (re) => re.test(blob);
  for (const [label, re] of [
    ['basic_pitch', /basic_pitch/],
    ['piano_transcription', /piano_transcription/],
    ['hft_transformer', /hft_transformer/],
    ['miros', /miros/],
    ['yourmt3', /yourmt3/],
    ['muscriptor', /muscriptor/],
    ['beat_this', /beat_this/],
    ['audio_tagger', /audio_tagger/],
    ['aria', /aria/],
  ]) app.assert(has(re), '模型家族存在：' + label);

  const sep = list.filter((m) => m.kind === 'separate');
  app.assert(sep.length >= 20, '分离模型 >= 20，实际 ' + sep.length);
  app.assert(sep.some((m) => /htdemucs|6stems|4stems/i.test([m.id, m.outName, m.name].join(' '))), '分轨模型包含 HTDemucs/6stems');
  const muscriptor = list.filter((m) => /muscriptor/i.test(String(m.id || '')));
  app.assert(muscriptor.length >= 3, 'MuScriptor 三种规格都在');

  // 转录入口仍在（不实际跑推理：真实推理由 transcribe-queue-chain 覆盖）
  app.assert(await app.eval('typeof window.fuBridge.convert === "function"'), 'convert 桥存在');
}
