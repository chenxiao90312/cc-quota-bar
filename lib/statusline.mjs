// Claude Code statusline — 跨平台主渲染逻辑
// 输出三行：user@host + dir + git branch / 表头 / 表值（Model | Context | Session | Usage|Cost Ref）

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { getQuota, formatUsageColumn, isApiBilling } from './quota.mjs';

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
  const usage = data?.context_window?.current_usage || {};
  const uncachedInput = usage.input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheCreate = usage.cache_creation_input_tokens || 0;
  const cacheCreate5m = usage.cache_creation?.ephemeral_5m_input_tokens || 0;
  const cacheCreate1h = usage.cache_creation?.ephemeral_1h_input_tokens || 0;
  const ctxPct = Math.floor(data?.context_window?.used_percentage || 0);

  const totalInput = uncachedInput + cacheRead + cacheCreate;
  const totalOut = data?.context_window?.total_output_tokens || 0;

  // 价格表（每 MTok USD），来源 https://platform.claude.com/docs/en/about-claude/pricing
  const PRICING = {
    'opus-4-7':   { input: 5,  output: 25, cacheRead: 0.50, cacheWrite5m: 6.25, cacheWrite1h: 10 },
    'opus-4-6':   { input: 5,  output: 25, cacheRead: 0.50, cacheWrite5m: 6.25, cacheWrite1h: 10 },
    'opus-4-5':   { input: 5,  output: 25, cacheRead: 0.50, cacheWrite5m: 6.25, cacheWrite1h: 10 },
    'sonnet-4-6': { input: 3,  output: 15, cacheRead: 0.30, cacheWrite5m: 3.75, cacheWrite1h: 6 },
    'sonnet-4-5': { input: 3,  output: 15, cacheRead: 0.30, cacheWrite5m: 3.75, cacheWrite1h: 6 },
    'haiku-4-5':  { input: 1,  output: 5,  cacheRead: 0.10, cacheWrite5m: 1.25, cacheWrite1h: 2 },
  };
  const modelId = data?.model?.id || '';

  // 跨 session 状态目录（每 session 一个 JSON）
  const sessionId = data?.session_id || 'unknown';
  const stateDir = path.join(os.homedir(), '.cache', 'claude-statusline', 'state');
  try { fs.mkdirSync(stateDir, { recursive: true }); } catch {}
  const stateFile = path.join(stateDir, `${sessionId}.json`);

  let state = { snapshot: 0, cumUncached: 0, cumCacheRead: 0, cumCacheCreate: 0, cumOutput: 0, byModel: {} };
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (!state.byModel) state.byModel = {};
  } catch {}

  const modelKey = Object.keys(PRICING).find(k => modelId.includes(k)) || 'unknown';
  const emptyBucket = { uncached: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 };

  if (totalOut > state.snapshot) {
    const outputDelta = totalOut - state.snapshot;
    state.snapshot = totalOut;
    state.cumUncached += uncachedInput;
    state.cumCacheRead += cacheRead;
    state.cumCacheCreate += cacheCreate;
    state.cumOutput += outputDelta;
    if (!state.byModel[modelKey]) state.byModel[modelKey] = { ...emptyBucket };
    state.byModel[modelKey].uncached += uncachedInput;
    state.byModel[modelKey].cacheRead += cacheRead;
    state.byModel[modelKey].cacheWrite5m += cacheCreate5m;
    state.byModel[modelKey].cacheWrite1h += cacheCreate1h;
    state.byModel[modelKey].output += outputDelta;
  } else if (totalOut < state.snapshot) {
    state = { snapshot: totalOut, cumUncached: uncachedInput, cumCacheRead: cacheRead, cumCacheCreate: cacheCreate, cumOutput: 0, byModel: {} };
    state.byModel[modelKey] = { ...emptyBucket, uncached: uncachedInput, cacheRead, cacheWrite5m: cacheCreate5m, cacheWrite1h: cacheCreate1h, output: 0 };
  }

  // 自愈：byModel 总和与累计偏差归到 dominant model
  const modelEntries = Object.entries(state.byModel || {});
  if (modelEntries.length > 0) {
    let sumU = 0, sumCR = 0, sumCW = 0, sumO = 0;
    let dominantKey = modelEntries[0][0], dominantCacheRead = 0;
    for (const [mk, t] of modelEntries) {
      sumU += t.uncached || 0;
      sumCR += t.cacheRead || 0;
      sumCW += (t.cacheWrite5m || 0) + (t.cacheWrite1h || 0);
      sumO += t.output || 0;
      if ((t.cacheRead || 0) > dominantCacheRead) { dominantCacheRead = t.cacheRead || 0; dominantKey = mk; }
    }
    const d = state.byModel[dominantKey];
    if (state.cumUncached - sumU > 0) d.uncached += state.cumUncached - sumU;
    if (state.cumCacheRead - sumCR > 0) d.cacheRead += state.cumCacheRead - sumCR;
    if (state.cumCacheCreate - sumCW > 0) d.cacheWrite1h += state.cumCacheCreate - sumCW;
    if (state.cumOutput - sumO > 0) d.output += state.cumOutput - sumO;
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

  const cumTotal = state.cumUncached + state.cumCacheRead + state.cumCacheCreate;
  const sessionHitRate = cumTotal > 0 ? Math.floor(state.cumCacheRead * 100 / cumTotal) : 0;

  const toUSD = (tokens, pricePerMTok) => tokens * pricePerMTok / 1_000_000;
  let sessionCost = 0;
  for (const [mk, t] of Object.entries(state.byModel || {})) {
    const p = PRICING[mk] || PRICING['opus-4-7'];
    sessionCost += toUSD(t.uncached || 0, p.input)
      + toUSD(t.cacheRead || 0, p.cacheRead)
      + toUSD(t.cacheWrite5m || 0, p.cacheWrite5m)
      + toUSD(t.cacheWrite1h || 0, p.cacheWrite1h)
      + toUSD(t.output || 0, p.output);
  }
  const fmtCost = (v) => v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`;
  const fmt = (n) => n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + 'M' : n >= 1000 ? Math.floor(n / 1000) + 'k' : String(n);

  // 颜色
  const c = (code, text) => `\x1b[${code}m${text}\x1b[0m`;
  const GREEN = '32', YELLOW = '33', CYAN = '36', BLUE = '34', DIM = '2';

  let line1 = `${c(GREEN, `${user}@${host}`)} ${c(YELLOW, cwd)}`;
  if (gitBranch) line1 += ` ${c(CYAN, `(${gitBranch})`)}`;

  const colModel = model;
  const colCtx = `${fmt(totalInput)}(${ctxPct}%)`;
  const sessionTotal = cumTotal + totalOut;
  const colSession = `${fmt(sessionTotal)} in:${fmt(state.cumCacheRead)}/${fmt(cumTotal)}(${sessionHitRate}%) out:${fmt(totalOut)} cacheW:${fmt(state.cumCacheCreate)}`;
  const showUsage = !isApiMode && usageColumn != null;
  const colCost = showUsage ? usageColumn : fmtCost(sessionCost);
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
