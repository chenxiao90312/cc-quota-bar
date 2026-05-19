// Claude Code statusline — 跨平台主渲染逻辑
// 输出三行：user@host + dir + git branch / 表头 / 表值（Model | Context | Session | Usage|Cost Ref）

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { getQuota, formatUsageColumn, isApiBilling } from './quota.mjs';
import { findPricing, calcCost } from './pricing.mjs';

// State schema 版本。session token 累计 v2 起完全从 transcript JSONL 实扫（type:assistant
// 的 message.usage），不再依赖 data.context_window 字段——后者实测是 turn-level 快照，
// 不是 session 累计，原来的 delta 逻辑长期低报 50-100x。schemaVersion 不匹配 → 弃旧
// byModel，重新从 transcript offset=0 全量扫一次（一次性成本，后续 incremental）。
const SCHEMA_VERSION = 2;
const EMPTY_BUCKET = { uncached: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 };

export async function renderStatusline(rawJson) {
  const data = JSON.parse(rawJson);

  // 订阅 vs API Billing 模式判定
  let usageColumn = null;
  let isApiMode = false;
  try {
    isApiMode = isApiBilling();
    if (!isApiMode) {
      const q = await getQuota({ nonBlocking: true });
      usageColumn = formatUsageColumn(q);
    }
  } catch {
    usageColumn = null;
  }

  const cwd = data?.workspace?.current_dir || '';
  const user = os.userInfo().username;
  const host = os.hostname();

  const devNull = process.platform === 'win32' ? 'nul' : '/dev/null';
  let gitBranch = '';
  try {
    gitBranch = execSync(
      `git symbolic-ref --short HEAD 2>${devNull} || git describe --tags --exact-match 2>${devNull} || git rev-parse --short HEAD 2>${devNull}`,
      { cwd: cwd || undefined, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
  } catch {}

  const model = data?.model?.display_name || 'unknown';
  // Ctx 列只用 context_window 当前快照（这是它的真正语义：当前 context 占用），
  // 不再用它累加。Session 累计走 transcript 实扫。
  const usage = data?.context_window?.current_usage || {};
  const ctxInput =
    (usage.input_tokens || 0)
    + (usage.cache_read_input_tokens || 0)
    + (usage.cache_creation_input_tokens || 0);
  const ctxPct = Math.floor(data?.context_window?.used_percentage || 0);

  // 跨 session 状态目录（每 session 一个 JSON）
  const sessionId = data?.session_id || 'unknown';
  const stateDir = path.join(os.homedir(), '.cache', 'claude-statusline', 'state');
  try { fs.mkdirSync(stateDir, { recursive: true }); } catch {}
  const stateFile = path.join(stateDir, `${sessionId}.json`);

  // schema v2：byModel 完全由 transcript 实扫累加；cumX 不存储、显示时从 byModel 派生。
  // 老 schema (v0/v1) 直接丢弃 byModel + cumX + snapshot，从 transcript offset=0 重扫。
  let state = { schemaVersion: SCHEMA_VERSION, transcriptOffset: 0, sidechainOffsets: {}, byModel: {} };
  try {
    const loaded = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (loaded.schemaVersion === SCHEMA_VERSION) {
      state.transcriptOffset = typeof loaded.transcriptOffset === 'number' ? loaded.transcriptOffset : 0;
      state.sidechainOffsets = (loaded.sidechainOffsets && typeof loaded.sidechainOffsets === 'object') ? loaded.sidechainOffsets : {};
      state.byModel = (loaded.byModel && typeof loaded.byModel === 'object') ? loaded.byModel : {};
    }
  } catch {}

  // 累加器：JSONL 文件从 offset 起增量扫，type:assistant 的 message.usage 按 model 计入 byModel。
  // 返回新 offset（字节）。字节级 \n 检测保证 CJK 多字节内容下 offset 正确。
  function accumulateJsonl(filePath, offset) {
    let fstat;
    try { fstat = fs.statSync(filePath); } catch { return offset; }
    if (offset > fstat.size) offset = 0;          // 文件被替换/截断 → 重新从头扫
    if (offset >= fstat.size) return offset;
    const len = fstat.size - offset;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(filePath, 'r');
    let bytesRead = 0;
    try { bytesRead = fs.readSync(fd, buf, 0, len, offset); } finally { fs.closeSync(fd); }
    let lastNl = -1;
    for (let i = bytesRead - 1; i >= 0; i--) {
      if (buf[i] === 0x0A) { lastNl = i; break; }
    }
    const consumed = lastNl < 0 ? 0 : lastNl + 1;
    if (consumed === 0) return offset;
    const text = buf.slice(0, consumed).toString('utf8');
    for (const line of text.split('\n')) {
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.type !== 'assistant') continue;
      const u = entry.message?.usage;
      if (!u) continue;
      const m = entry.message?.model || '';
      const matched = findPricing(m);
      const key = matched ? matched.displayKey : (m || 'unknown');
      if (!state.byModel[key]) state.byModel[key] = { ...EMPTY_BUCKET };
      const b = state.byModel[key];
      b.uncached     += u.input_tokens || 0;
      b.cacheRead    += u.cache_read_input_tokens || 0;
      b.cacheWrite5m += u.cache_creation?.ephemeral_5m_input_tokens || 0;
      b.cacheWrite1h += u.cache_creation?.ephemeral_1h_input_tokens || 0;
      b.output       += u.output_tokens || 0;
    }
    return offset + consumed;
  }

  const transcriptPath = data?.transcript_path;
  if (transcriptPath) {
    state.transcriptOffset = accumulateJsonl(transcriptPath, state.transcriptOffset);
    const subagentsDir = path.join(
      path.dirname(transcriptPath),
      path.basename(transcriptPath, '.jsonl'),
      'subagents'
    );
    let files = [];
    try { files = fs.readdirSync(subagentsDir).filter((f) => f.endsWith('.jsonl')); } catch {}
    for (const fname of files) {
      const off = typeof state.sidechainOffsets[fname] === 'number' ? state.sidechainOffsets[fname] : 0;
      state.sidechainOffsets[fname] = accumulateJsonl(path.join(subagentsDir, fname), off);
    }
  }

  try { fs.writeFileSync(stateFile, JSON.stringify(state)); } catch {}

  // 7 天前的 state 文件清理
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(stateDir)) {
      const fp = path.join(stateDir, f);
      if (now - fs.statSync(fp).mtimeMs > 7 * 86400000) fs.unlinkSync(fp);
    }
  } catch {}

  // 累计值从 byModel 派生（不再存 cumX，单一来源，杜绝 sum-vs-cum 漂移）
  let cumUncached = 0, cumCacheRead = 0, cumCacheCreate = 0, cumOutput = 0;
  let sessionCost = 0;
  let hasUnmatched = false;
  for (const [mk, t] of Object.entries(state.byModel || {})) {
    cumUncached    += t.uncached || 0;
    cumCacheRead   += t.cacheRead || 0;
    cumCacheCreate += (t.cacheWrite5m || 0) + (t.cacheWrite1h || 0);
    cumOutput      += t.output || 0;
    const r = findPricing(mk);
    if (!r) { hasUnmatched = true; continue; }   // 未匹配模型不计入，避免错算
    sessionCost += calcCost(t, r.rate);
  }
  const cumTotal = cumUncached + cumCacheRead + cumCacheCreate;
  const sessionHitRate = cumTotal > 0 ? Math.floor(cumCacheRead * 100 / cumTotal) : 0;
  const fmtCost = (v) => v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`;
  const fmt = (n) => n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + 'M' : n >= 1000 ? Math.floor(n / 1000) + 'k' : String(n);

  // 颜色
  const c = (code, text) => `\x1b[${code}m${text}\x1b[0m`;
  const GREEN = '32', YELLOW = '33', CYAN = '36', BLUE = '34', DIM = '2';

  let line1 = `${c(GREEN, `${user}@${host}`)} ${c(YELLOW, cwd)}`;
  if (gitBranch) line1 += ` ${c(CYAN, `(${gitBranch})`)}`;

  const colModel = model;
  const colCtx = `${fmt(ctxInput)}(${ctxPct}%)`;
  const sessionTotal = cumTotal + cumOutput;
  const colSession = `${fmt(sessionTotal)} in:${fmt(cumCacheRead)}/${fmt(cumTotal)}(${sessionHitRate}%) out:${fmt(cumOutput)} cacheW:${fmt(cumCacheCreate)}`;
  const showUsage = !isApiMode && usageColumn != null;
  // Cost 模式：模型不在 anthropic 表里 → "-- (not supported)"，不假装能算。
  // 混合 session（部分匹配）→ 显示已知部分 + dim "(partial)"
  let costStr;
  if (!hasUnmatched) costStr = fmtCost(sessionCost);
  else if (sessionCost === 0) costStr = c(DIM, '-- (not supported)');
  else costStr = `${fmtCost(sessionCost)} ${c(DIM, '(partial)')}`;
  const colCost = showUsage ? usageColumn : costStr;
  const labelRight = showUsage ? 'Usage:' : 'Cost:';

  // 2x2 布局：行 2 = Model | Usage/Cost；行 3 = Ctx | Session
  // label 用 dim，左半 padEnd 让 | 对齐
  const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const left2 = `${c(DIM, 'Model:')} ${c(BLUE, colModel)}`;
  const left3 = `${c(DIM, 'Ctx:')} ${colCtx}`;
  const leftWidth = Math.max(stripAnsi(left2).length, stripAnsi(left3).length);
  const padLeft = (s) => s + ' '.repeat(Math.max(0, leftWidth - stripAnsi(s).length));
  const right2 = `${c(DIM, labelRight)} ${colCost}`;
  const right3 = `${c(DIM, 'Session:')} ${colSession}`;

  const line2 = `${padLeft(left2)} ${c(DIM, '|')} ${right2}`;
  const line3 = `${padLeft(left3)} ${c(DIM, '|')} ${right3}`;

  return [line1, line2, line3].join('\n');
}
