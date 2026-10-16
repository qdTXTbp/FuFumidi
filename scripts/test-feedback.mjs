// ============================================================
// 反馈上传的离线单测（客户端侧）：脱敏 golden + md 模板形状 + 文件名规范。
// 用法：npm run test:feedback
//
// 这些断言是**隐私闸门**：脱敏一旦回归，这里必须红。
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const F = require('../main/feedback-format.js');

const OPTS = { hostname: 'DESKTOP-AB12CD', username: 'someuser' };

test('脱敏：Windows / macOS / Linux 家目录都换成 <用户>', () => {
  assert.equal(F.sanitizeText('C:\\Users\\someuser\\Music\\a.mid', OPTS), 'C:\\Users\\<用户>\\Music\\a.mid');
  assert.equal(F.sanitizeText('C:/Users/someuser/Music/a.mid', OPTS), 'C:/Users/<用户>/Music/a.mid');
  assert.equal(F.sanitizeText('/home/someuser/music/a.mid', OPTS), '/home/<用户>/music/a.mid');
  assert.equal(F.sanitizeText('/Users/someuser/Music/a.mid', OPTS), '/Users/<用户>/Music/a.mid');
});

test('脱敏：主机名与用户名（含散落在日志中间的那次）', () => {
  const s = F.sanitizeText('[info] host=DESKTOP-AB12CD user=someuser path=C:\\Users\\someuser', OPTS);
  assert.ok(!s.includes('DESKTOP-AB12CD'), s);
  assert.ok(!s.includes('someuser'), s);
  assert.ok(s.includes('<主机名>') && s.includes('<用户>'), s);
});

test('脱敏：令牌形状（hf_ / ghp_ / Bearer / 32+ 位 hex / JWT / URL 参数）', () => {
  const cases = [
    'hf_abcdefghijklmnopqrstuvwx',
    'ghp_abcdefghijklmnopqrstuvwx',
    'Bearer abcdefghijklmnop',
    '0123456789abcdef0123456789abcdef',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop',
    'https://x/y?token=abcdefghijklmnop',
  ];
  for (const c of cases) {
    const out = F.sanitizeText('日志：' + c, OPTS);
    assert.ok(out.includes('<已隐藏>'), c + ' → ' + out);
    assert.ok(!/hf_abcdefghijklmnopqrstuvwx|ghp_abcdefghijklmnopqrstuvwx|0123456789abcdef0123456789abcdef/.test(out), c);
  }
});

test('脱敏：短主机名不动（避免把常见短词吃掉）', () => {
  const out = F.sanitizeText('pc 上跑的', { hostname: 'pc', username: 'ab' });
  assert.equal(out, 'pc 上跑的');
});

test('scrubSettings：按 key 删敏感字段（token/email/password…），其余保留但过脱敏', () => {
  const out = F.scrubSettings({
    theme: 'dark',
    hfToken: 'hf_abcdefghijklmnopqrstuvwx',
    account: { email: 'a@b.com', password: 'x', nickname: 'n' },
    libraryPath: 'C:\\Users\\someuser\\Music',
  }, OPTS);
  assert.ok(!out.includes('hf_abcdefghijklmnopqrstuvwx'), out);
  assert.ok(!out.includes('a@b.com'), out);
  assert.ok(out.includes('<已移除>'), out);
  assert.ok(out.includes('dark'), '非敏感设置应保留');
  assert.ok(out.includes('C:\\\\Users\\\\<用户>') || out.includes('C:\\Users\\<用户>'), out);
});

test('sanitizeLog：超长日志只留尾部并标注截断', () => {
  // 用"像日志"的输入：全是同一种字符的长串会被令牌规则吃掉（那是另一条断言的事）
  const big = Array.from({ length: 400 }, (_, i) => 'line ' + i + ' ok').join('\n') + '\nTAIL';
  const out = F.sanitizeLog(big, OPTS, 200);
  assert.ok(out.length < 400, String(out.length));
  assert.ok(out.includes('TAIL'), '尾部必须保留');
  assert.ok(out.includes('截断'));
});

test('文件名规范：slug 取标题；纯中文标题退化成 kind；id 带年月日', () => {
  assert.equal(F.fileNameFor('2026-10-16-a1b2c3', 'Score page 2 fails', 'bug'),
    'issues/2026/10/2026-10-16-a1b2c3-score-page-2-fails.md');
  assert.equal(F.fileNameFor('2026-10-16-a1b2c3', '变谱第 2 页总是识别失败', 'bug'),
    'issues/2026/10/2026-10-16-a1b2c3-bug.md', '纯中文标题不能只剩个数字');
  assert.equal(F.fileNameFor('2026-10-16-a1b2c3', '', 'quality'),
    'issues/2026/10/2026-10-16-a1b2c3-quality.md');
  assert.match(F.fileNameFor('2026-11-02-zzzzzz', 'x y', 'crash'), /^issues\/2026\/11\/2026-11-02-zzzzzz-/);
});

test('md 模板：front-matter 字段齐全、附件清单与勾选一致、体检报告进折叠块', () => {
  const md = F.buildMarkdown({
    kind: 'bug', area: 'score', severity: 'major', title: '第 2 页识别失败',
    symptom: '第 2 页永远失败', steps: '1. 拖进来\n2. 等结果', expect: '应该能出', freq: '每次', contact: 'me@example.com',
  }, {
    id: '2026-10-16-a1b2c3', createdAt: '2026-10-16T01:23:45+08:00',
    appVersion: '5.1.0', build: 'f4c1938', os: 'Windows 11 23H2 (x64)', cpu: 'Ryzen', gpu: 'RTX 5070 Ti', mem: '32 GB',
    install: '安装版', installId: '8f3c1d2e', healthReport: '系统：Windows\n显卡：RTX 5070 Ti',
    hasDiagnostic: true, attachments: [{ name: 'diagnostic.zip', bytes: 4404019, sha256: 'abcdef1234567890' }],
    source: 'app',
  });
  const fm = md.split('---')[1];
  for (const k of ['id:', 'title:', 'kind:', 'area:', 'severity:', 'app:', 'os:', 'install_id:', 'created:', 'contact:']) {
    assert.ok(fm.includes(k), '缺字段 ' + k + '\n' + fm);
  }
  // YAML 列表项里带冒号会被引号包起来（yamlStr 的行为），断言两种形式都接受
  assert.ok(/^  - "?diagnostic\.zip \(4\.2 MB, sha256: abcdef123456\)"?$/m.test(md), md);
  assert.ok(md.includes('- [x] 诊断包'), md);
  assert.ok(md.includes('- [x] 体检报告'), md);
  assert.ok(md.includes('<details><summary>体检报告'), md);
  assert.ok(md.includes('## 症状') && md.includes('## 复现步骤') && md.includes('## 期望 vs 实际') && md.includes('## 频率'), md);
  assert.ok(md.trimEnd().endsWith('-->'), '结尾应有来源标注');
});

test('md 模板：没填的可选项不出现多余小节，附件为空时写 []', () => {
  const md = F.buildMarkdown({ kind: 'idea', area: 'edit', severity: 'minor', title: '想法', symptom: '想要某某' },
    { id: '2026-10-16-aaaaaa', createdAt: 'x', appVersion: '5.1.0', os: 'Windows', install: '安装版', installId: 'i', healthReport: '' });
  assert.ok(md.includes('attachments: []'), md);
  assert.ok(!md.includes('## 复现步骤'), md);
  assert.ok(!md.includes('<details>'), md);
  assert.ok(md.includes('- [ ] 诊断包') && md.includes('- [ ] 体检报告'), '没带附件时应是未勾选');
});
