#!/usr/bin/env node
// cc-quota-bar setup（npx-first）
//
// 一条命令完成全部：
//   1. 把代码复制到 ~/.local/share/cc-quota-bar/（XDG 标准稳定路径）
//   2. 写入 ~/.claude/settings.json，statusLine 指向稳定路径
//   3. 烟雾测试
//
// 入口：npx cc-quota-bar  /  claude-status-bar-setup（npm install -g 后的别名）

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const STABLE_DIR = path.join(os.homedir(), '.local', 'share', 'cc-quota-bar');
// 包内需要复制到稳定路径的目录/文件
const COPY_ITEMS = ['bin', 'lib', 'package.json', 'README.md', 'LICENSE', 'quota.mjs'];

function log(msg) { console.log(msg); }
function die(msg) { console.error(`✗ ${msg}`); process.exit(1); }

function checkNode() {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 18) die(`需要 Node >= 18（当前 ${process.version}）。建议用 nvm/Volta 升级。`);
  log(`✓ Node ${process.version}`);
}

// 找到当前 setup.mjs 所在的 package root（解 symlink）
function findPackageRoot() {
  const realSetup = fs.realpathSync(fileURLToPath(import.meta.url));
  // realSetup 形如 /<root>/bin/setup.mjs，root 是 setup 的上两级
  return path.dirname(path.dirname(realSetup));
}

// 复制 package 到 STABLE_DIR；返回稳定路径下的 setup 真实位置
function installToStable() {
  const sourceRoot = findPackageRoot();
  if (path.resolve(sourceRoot) === path.resolve(STABLE_DIR)) {
    log(`· 已在稳定路径运行（${STABLE_DIR}），跳过复制`);
    return STABLE_DIR;
  }

  fs.mkdirSync(STABLE_DIR, { recursive: true });

  for (const item of COPY_ITEMS) {
    const src = path.join(sourceRoot, item);
    const dst = path.join(STABLE_DIR, item);
    if (!fs.existsSync(src)) continue;
    // 升级场景：先清旧再复制（force: true 不是递归覆盖夹杂的旧文件）
    fs.rmSync(dst, { recursive: true, force: true });
    fs.cpSync(src, dst, { recursive: true });
  }

  // 确保 bin/* 可执行（npm 一般已 chmod，但 npx cache 解压偶有遗漏）
  const binDir = path.join(STABLE_DIR, 'bin');
  if (fs.existsSync(binDir)) {
    for (const f of fs.readdirSync(binDir)) {
      try { fs.chmodSync(path.join(binDir, f), 0o755); } catch {}
    }
  }

  log(`✓ 代码已部署到稳定路径：${STABLE_DIR}`);
  return STABLE_DIR;
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

function writeSettings(settings, statuslineBin) {
  const oldCmd = settings.statusLine?.command;
  if (oldCmd) {
    const willKeep = oldCmd.includes(statuslineBin)
      || oldCmd.includes('cc-quota-bar')
      || oldCmd.includes('claude-status-bar');
    if (!willKeep) {
      log(`! 检测到已有 statusLine.command（将被覆盖，备份已保留）：`);
      log(`    ${oldCmd}`);
    }
  }
  settings.statusLine = {
    type: 'command',
    command: `node ${JSON.stringify(statuslineBin)}`,
  };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  log(`✓ 已写入 ${SETTINGS_PATH}`);
  log(`    statusLine.command = node ${JSON.stringify(statuslineBin)}`);
}

function smokeTest(statuslineBin) {
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
    const out = execSync(`node ${JSON.stringify(statuslineBin)}`, {
      input: payload, encoding: 'utf8', timeout: 15000,
    });
    log(`\n✓ 烟雾测试通过：\n${out.split('\n').map(l => '    ' + l).join('\n')}`);
  } catch (e) {
    log(`! 烟雾测试失败（不致命，可重试 \`echo '{}' | node ${statuslineBin}\`）：${e.message}`);
  }
}

function main() {
  log('cc-quota-bar setup');
  log(`  平台：${process.platform}\n`);
  checkNode();
  const stableRoot = installToStable();
  const statuslineBin = path.join(stableRoot, 'bin', 'statusline.mjs');
  if (!fs.existsSync(statuslineBin)) die(`稳定路径里找不到 statusline 入口：${statuslineBin}`);
  log(`✓ statusline 入口：${statuslineBin}\n`);

  const settings = backupAndLoadSettings();
  writeSettings(settings, statuslineBin);
  smokeTest(statuslineBin);

  log(`
完成。下一次 Claude Code statusline 刷新即生效（不用重启 session）。

· 订阅模式（默认）：第四栏显示 Usage 进度条（5h / 7d）
· API Billing 模式（设置 ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN）：自动切回 Cost Ref

升级：再跑一次 \`npx cc-quota-bar\`（自动覆盖稳定路径里的旧代码）

调试：
  node ${JSON.stringify(path.join(stableRoot, 'bin', 'quota.mjs'))} --status
  node ${JSON.stringify(path.join(stableRoot, 'bin', 'quota.mjs'))} --json
  node ${JSON.stringify(path.join(stableRoot, 'bin', 'quota.mjs'))} --refresh
`);
}

main();
