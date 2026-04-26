#!/usr/bin/env node
// claude-status-bar: 被 Claude Code 通过 settings.json 调用，从 stdin 读 JSON 渲染 statusline。

import { renderStatusline } from '../lib/statusline.mjs';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

try {
  const out = await renderStatusline(raw);
  console.log(out);
} catch (e) {
  // 任何渲染异常都降级输出最小信息，避免 statusline 完全空白
  console.log(`statusline error: ${e.message}`);
  process.exit(1);
}
