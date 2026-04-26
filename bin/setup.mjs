#!/usr/bin/env node
// claude-status-bar-setup
// 一键写入 ~/.claude/settings.json，让 Claude Code statusline 指向本包的 statusline.mjs。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

function log(msg) { console.log(msg); }
function die(msg) { console.error(`✗ ${msg}`); process.exit(1); }

function checkNode() {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 18) die(`需要 Node >= 18（当前 ${process.version}）。建议用 nvm/Volta 升级。`);
  log(`✓ Node ${process.version}`);
}

function resolveBinPath() {
  // setup.mjs 自身的真实路径（解 symlink 后），同目录下的 statusline.mjs 即为目标
  const realSetup = fs.realpathSync(fileURLToPath(import.meta.url));
  const binPath = path.join(path.dirname(realSetup), 'statusline.mjs');
  if (!fs.existsSync(binPath)) die(`找不到 statusline 入口：${binPath}`);
  return binPath;
}

function backupAndLoadSettings() {
  if (!fs.existsSync(SETTINGS_PATH)) {
    log(`· settings.json 不存在，将创建：${SETTINGS_PATH}`);
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    return {};
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${SETTINGS_PATH}.bak.${stamp}`;
  fs.copyFileSync(SETTINGS_PATH, backup);
  log(`✓ 备份原 settings.json → ${backup}`);
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch (e) {
    die(`原 settings.json 解析失败：${e.message}（已备份，恢复后再试）`);
  }
}

function writeSettings(settings, binPath) {
  const oldCmd = settings.statusLine?.command;
  if (oldCmd) {
    const willOverwrite = !oldCmd.includes('claude-status-bar') && !oldCmd.includes(binPath);
    if (willOverwrite) {
      log(`! 检测到已有 statusLine.command：`);
      log(`    ${oldCmd}`);
      log(`  将被覆盖（备份已保留，可随时恢复）`);
    }
  }
  settings.statusLine = {
    type: 'command',
    command: `node ${JSON.stringify(binPath)}`,
  };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  log(`✓ 已写入 ${SETTINGS_PATH}`);
  log(`    statusLine.command = node ${JSON.stringify(binPath)}`);
}

function smokeTest(binPath) {
  const payload = JSON.stringify({
    session_id: 'setup-smoke-test',
    model: { id: 'claude-opus-4-7', display_name: 'opus-4-7' },
    workspace: { current_dir: os.homedir() },
    context_window: {
      used_percentage: 0,
      current_usage: {
        input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      },
      total_input_tokens: 0, total_output_tokens: 0,
    },
  });
  try {
    const out = execSync(`node ${JSON.stringify(binPath)}`, {
      input: payload, encoding: 'utf8', timeout: 15000,
    });
    log(`\n✓ 烟雾测试通过：\n${out.split('\n').map(l => '    ' + l).join('\n')}`);
  } catch (e) {
    log(`! 烟雾测试失败（不致命，可重试 \`echo '{}' | node ${binPath}\`）：${e.message}`);
  }
}

function main() {
  log('claude-status-bar setup');
  log(`  平台：${process.platform}\n`);
  checkNode();
  const binPath = resolveBinPath();
  log(`✓ statusline 入口：${binPath}\n`);
  const settings = backupAndLoadSettings();
  writeSettings(settings, binPath);
  smokeTest(binPath);
  log(`
完成。下一次 Claude Code session 即生效。

· 订阅模式（默认）：第四栏显示 Usage 进度条（5h / 7d）
· API Billing 模式（设置 ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN）：第四栏自动切回 Cost Ref

调试命令：
  node ${JSON.stringify(path.join(path.dirname(binPath), 'quota.mjs'))} --status
  node ${JSON.stringify(path.join(path.dirname(binPath), 'quota.mjs'))} --json
  node ${JSON.stringify(path.join(path.dirname(binPath), 'quota.mjs'))} --refresh
`);
}

main();
