#!/usr/bin/env node
// 安装后提示。**不自动改用户配置** —— 仅 echo 下一步给用户。
// 如果 ~/.claude/settings.json 已指向本包，认为是升级场景，静默。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 仅 npm install -g 时提示；作为 dependency 安装时跳过。
// 注意：npx 不触发 postinstall（直接跑 bin），所以这个脚本只在 npm install 路径起作用。
if (process.env.npm_config_global !== 'true' && !process.env.npm_config_prefix) {
  process.exit(0);
}

const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
let alreadyDeployed = false;
try {
  const cmd = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))?.statusLine?.command || '';
  alreadyDeployed = cmd.includes('cc-quota-bar')
    || cmd.includes('claude-status-bar')
    || cmd.includes('.local/share/cc-quota-bar');
} catch {}

if (alreadyDeployed) {
  console.log('\n✓ cc-quota-bar updated.');
  console.log('  重新跑 setup 把代码同步到稳定路径：');
  console.log('    $ cc-quota-bar\n');
} else {
  console.log('\n✓ cc-quota-bar installed (但还未部署到 Claude Code)。');
  console.log('  下一步：');
  console.log('    $ cc-quota-bar       # 复制到 ~/.local/share/cc-quota-bar/ 并写 settings.json');
  console.log('  （或者直接跳过 npm install -g，下次用 `npx cc-quota-bar` 一行搞定）\n');
}
