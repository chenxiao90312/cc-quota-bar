// Claude Code statusline — 跨平台主渲染逻辑
// 输出三行：user@host + dir + git branch / 表头 / 表值（Model | Context | Session | Usage|Cost Ref）

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { getQuota, formatUsageColumn, isApiBilling } from './quota.mjs';
import { findPricing, calcCost } from './pricing.mjs';

// 旧 byModel key（v0.2.x）→ 新 displayKey 迁移表，保证升级后历史 session 不丢
const LEGACY_KEY_MAP = {
  'opus-4-7': 'claude-opus-4-7',
  'opus-4-6': 'claude-opus-4-6',
  'opus-4-5': 'claude-opus-4-5',
  'sonnet-4-6': 'claude-sonnet-4-6',
  'sonnet-4-5': 'claude-sonnet-4-5',
  'haiku-4-5': 'claude-haiku-4-5',
};

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

  const modelId = data?.model?.id || '';
  const matched = findPricing(modelId);
  // displayKey：匹配上则用 anthropic/openrouter 主键；未匹配兜底用原始 modelId（让未知模型独立累加）
  const modelKey = matched ? matched.displayKey : (modelId || 'unknown');

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

  // 一次性迁移：v0.2.x 短 key（opus-4-7）→ 新 displayKey（claude-opus-4-7）
  for (const [oldK, newK] of Object.entries(LEGACY_KEY_MAP)) {
    if (state.byModel[oldK]) {
      const dst = state.byModel[newK] || (state.byModel[newK] = { uncached: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 });
      const src = state.byModel[oldK];
      for (const k of Object.keys(src)) dst[k] = (dst[k] || 0) + (src[k] || 0);
      delete state.byModel[oldK];
    }
  }

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

  // Subagent (Task tool) 消耗：每个 subagent 在 <projectDir>/<sessionId>/subagents/agent-*.jsonl
  // 单独存档，每条 assistant 消息带独立 model + usage。Claude Code 传给 statusline 的
  // context_window 不含这部分 → 增量按文件扫，把 token 计入对应 model bucket 与全局累计。
  //
  // 偏移策略：state.sidechainOffsets 缺失 (老状态升级 / compaction 重置后) → 把已存在的
  // subagent 文件统统锚到 EOF，不回溯扫历史；这是与父会话累计同语义。后续新出现的
  // subagent 文件从 0 扫到 EOF，正常计入。
  const transcriptPath = data?.transcript_path;
  if (transcriptPath) {
    const transcriptDir = path.dirname(transcriptPath);
    const baseNoExt = path.basename(transcriptPath, '.jsonl');
    const subagentsDir = path.join(transcriptDir, baseNoExt, 'subagents');

    let files = [];
    try { files = fs.readdirSync(subagentsDir).filter((f) => f.endsWith('.jsonl')); } catch {}

    const firstInit = !state.sidechainOffsets || typeof state.sidechainOffsets !== 'object';
    if (firstInit) state.sidechainOffsets = {};

    for (const fname of files) {
      const fpath = path.join(subagentsDir, fname);
      let fstat;
      try { fstat = fs.statSync(fpath); } catch { continue; }

      let off = state.sidechainOffsets[fname];
      if (typeof off !== 'number' || off > fstat.size) {
        off = firstInit ? fstat.size : 0;
      }
      if (fstat.size <= off) { state.sidechainOffsets[fname] = off; continue; }

      try {
        const len = fstat.size - off;
        const buf = Buffer.alloc(len);
        const fd = fs.openSync(fpath, 'r');
        let bytesRead = 0;
        try { bytesRead = fs.readSync(fd, buf, 0, len, off); }
        finally { fs.closeSync(fd); }
        // 偏移用字节，不能用字符索引（CJK UTF-8 多字节会让 char index < byte length）
        let lastNl = -1;
        for (let i = bytesRead - 1; i >= 0; i--) {
          if (buf[i] === 0x0A) { lastNl = i; break; }
        }
        const consumed = lastNl < 0 ? 0 : lastNl + 1;
        if (consumed > 0) {
          const text = buf.slice(0, consumed).toString('utf8');
          for (const line of text.split('\n')) {
            if (!line) continue;
            let entry;
            try { entry = JSON.parse(line); } catch { continue; }
            if (entry.type !== 'assistant') continue;
            const u = entry.message?.usage;
            if (!u) continue;
            const sideModel = entry.message?.model || '';
            const sideMatched = findPricing(sideModel);
            const sideKey = sideMatched ? sideMatched.displayKey : (sideModel || 'unknown');
            if (!state.byModel[sideKey]) state.byModel[sideKey] = { ...emptyBucket };
            const b = state.byModel[sideKey];
            const sUncached = u.input_tokens || 0;
            const sCacheRead = u.cache_read_input_tokens || 0;
            const sCacheCreate = u.cache_creation_input_tokens || 0;
            const s5m = u.cache_creation?.ephemeral_5m_input_tokens || 0;
            const s1h = u.cache_creation?.ephemeral_1h_input_tokens || 0;
            const sOut = u.output_tokens || 0;
            b.uncached += sUncached;
            b.cacheRead += sCacheRead;
            b.cacheWrite5m += s5m;
            b.cacheWrite1h += s1h;
            b.output += sOut;
            state.cumUncached += sUncached;
            state.cumCacheRead += sCacheRead;
            state.cumCacheCreate += sCacheCreate;
            state.cumOutput += sOut;
          }
          state.sidechainOffsets[fname] = off + consumed;
        }
      } catch {}
    }
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

  let sessionCost = 0;
  let hasUnmatched = false;
  for (const [mk, t] of Object.entries(state.byModel || {})) {
    const r = findPricing(mk);
    if (!r) { hasUnmatched = true; continue; }   // 未匹配模型不计入，避免错算
    sessionCost += calcCost(t, r.rate);
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
  // Session 列展示累计值（含 subagent），父会话当前 turn 用 totalOut 反映在 Ctx 列即可
  const sessionTotal = cumTotal + state.cumOutput;
  const colSession = `${fmt(sessionTotal)} in:${fmt(state.cumCacheRead)}/${fmt(cumTotal)}(${sessionHitRate}%) out:${fmt(state.cumOutput)} cacheW:${fmt(state.cumCacheCreate)}`;
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
