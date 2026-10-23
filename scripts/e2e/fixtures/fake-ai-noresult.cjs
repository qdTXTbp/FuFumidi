#!/usr/bin/env node
// E2E 固件：模拟"能跑但不产出 result.json"的 AI 生成命令（验证 bad-result 分支）
process.stdout.write('fake-ai: no result.json\n');
process.exit(0);
