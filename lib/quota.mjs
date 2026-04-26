// claude-status-bar / quota：查询 Claude 官方订阅额度（与 /usage 同源 API）
// 跨平台：Linux / macOS（macOS 优先读 Keychain，回退到文件）
//
// 缓存：~/.cache/claude-quota/cache.json   TTL 60s
// 锁  ：~/.cache/claude-quota/lock.d/      mkdir 原子锁，孤儿 2min 自清

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CACHE_DIR = path.join(os.homedir(), '.cache', 'claude-quota');
const CACHE_FILE = path.join(CACHE_DIR, 'cache.json');
const LOCK_DIR = path.join(CACHE_DIR, 'lock.d');

const TTL_MS = 60 * 1000;
const LOCK_ORPHAN_MS = 120 * 1000;
const HTTP_TIMEOUT_MS = 8 * 1000;

// ─── 凭据读取（macOS Keychain → 文件 fallback） ───────────
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

function readKeychainOnDarwin() {
  if (process.platform !== 'darwin') return null;
  try {
    const out = execSync(`security find-generic-password -s ${JSON.stringify(KEYCHAIN_SERVICE)} -w`, {
      stdio: ['pipe', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: 3000,
    }).trim();
    return out || null;
  } catch {
    return null; // Keychain 没条目（用户从未登录或刚注销）
  }
}

function readCredentialsFile() {
  const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
  try {
    return fs.readFileSync(credPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { __error: 'not_found', message: 'credentials file missing' };
    return { __error: 'read_error', message: e.message };
  }
}

function parseCredentials(raw) {
  let json;
  try { json = JSON.parse(raw); }
  catch (e) { return { ok: false, status: 'parse_error', message: `JSON parse: ${e.message}` }; }

  const entry = json.claudeAiOauth || json['claude.ai_oauth'];
  if (!entry?.accessToken) {
    return { ok: false, status: 'parse_error', message: 'missing claudeAiOauth.accessToken' };
  }

  let expired = false;
  const exp = entry.expiresAt;
  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof exp === 'number') {
    const sec = exp > 1e12 ? Math.floor(exp / 1000) : exp;
    expired = sec < nowSec;
  } else if (typeof exp === 'string') {
    const t = Date.parse(exp);
    if (!Number.isNaN(t)) expired = t / 1000 < nowSec;
  }
  return { ok: true, accessToken: entry.accessToken, expired };
}

function readCredentials() {
  // macOS：Keychain 优先
  const keychainRaw = readKeychainOnDarwin();
  if (keychainRaw) {
    const r = parseCredentials(keychainRaw);
    if (r.ok) return r;
    // Keychain 解析失败 → 继续 fallback 到文件
  }

  const fileRaw = readCredentialsFile();
  if (typeof fileRaw === 'object' && fileRaw.__error) {
    return { ok: false, status: fileRaw.__error, message: fileRaw.message };
  }
  return parseCredentials(fileRaw);
}

// ─── 调 Anthropic API ─────────────────────────────────────
async function fetchQuotaApi(accessToken) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const resp = await fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Accept': 'application/json',
      },
      signal: ctrl.signal,
    });
    if (resp.status === 401 || resp.status === 403) {
      return { ok: false, httpStatus: resp.status, errorCode: 'auth_expired', error: `HTTP ${resp.status}` };
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return { ok: false, httpStatus: resp.status, errorCode: 'http_error', error: `HTTP ${resp.status}: ${body.slice(0, 200)}` };
    }
    const body = await resp.json();
    return { ok: true, body };
  } catch (e) {
    return { ok: false, errorCode: 'network', error: e.name === 'AbortError' ? `timeout after ${HTTP_TIMEOUT_MS}ms` : e.message };
  } finally {
    clearTimeout(timer);
  }
}

const KNOWN_TIERS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];

function parseQuotaBody(body) {
  const tiers = [];
  for (const name of KNOWN_TIERS) {
    const w = body[name];
    if (w && typeof w.utilization === 'number') {
      tiers.push({ name, utilization: w.utilization, resets_at: w.resets_at || null });
    }
  }
  for (const [k, v] of Object.entries(body)) {
    if (k === 'extra_usage' || KNOWN_TIERS.includes(k)) continue;
    if (v && typeof v === 'object' && typeof v.utilization === 'number') {
      tiers.push({ name: k, utilization: v.utilization, resets_at: v.resets_at || null });
    }
  }
  const e = body.extra_usage;
  const extra_usage = e ? {
    is_enabled: !!e.is_enabled,
    monthly_limit: e.monthly_limit ?? null,
    used_credits: e.used_credits ?? null,
    utilization: e.utilization ?? null,
    currency: e.currency ?? null,
  } : null;
  return { tiers, extra_usage };
}

// ─── 缓存读写 ─────────────────────────────────────────────
function ensureCacheDir() {
  fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
}

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
  catch { return null; }
}

function writeCache(payload) {
  ensureCacheDir();
  const tmp = `${CACHE_FILE}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
  fs.renameSync(tmp, CACHE_FILE);
}

// ─── 锁（mkdir 原子，孤儿自动清理） ──────────────────────
function clearOrphanLock() {
  try {
    const st = fs.statSync(LOCK_DIR);
    if (Date.now() - st.mtimeMs > LOCK_ORPHAN_MS) {
      try { fs.rmdirSync(LOCK_DIR); } catch {}
    }
  } catch {}
}

function tryAcquireLock() {
  ensureCacheDir();
  clearOrphanLock();
  try { fs.mkdirSync(LOCK_DIR); return true; }
  catch { return false; }
}

function releaseLock() {
  try { fs.rmdirSync(LOCK_DIR); } catch {}
}

function isLocked() {
  clearOrphanLock();
  try { fs.statSync(LOCK_DIR); return true; }
  catch { return false; }
}

// ─── 刷新核心 ─────────────────────────────────────────────
export async function refreshWithLock() {
  if (!tryAcquireLock()) return null;
  try { return await doRefresh(); }
  finally { releaseLock(); }
}

async function doRefresh() {
  const cred = readCredentials();
  if (!cred.ok) {
    const payload = {
      ok: false, fetched_at: Date.now(),
      credential_status: cred.status, error: cred.message,
      tiers: [], extra_usage: null,
    };
    writeCache(payload);
    return payload;
  }

  const r = await fetchQuotaApi(cred.accessToken);
  if (!r.ok) {
    const old = readCache();
    const payload = {
      ok: false, fetched_at: Date.now(),
      credential_status: r.errorCode === 'auth_expired' ? 'expired' : 'valid',
      error: r.error,
      tiers: old?.tiers || [], extra_usage: old?.extra_usage || null,
      stale: true,
    };
    writeCache(payload);
    return payload;
  }

  const parsed = parseQuotaBody(r.body);
  const payload = {
    ok: true, fetched_at: Date.now(),
    credential_status: 'valid',
    tiers: parsed.tiers, extra_usage: parsed.extra_usage,
  };
  writeCache(payload);
  return payload;
}

// ─── 后台 fork ────────────────────────────────────────────
function spawnBackgroundRefresh() {
  // 直接 fork 自己（lib/quota.mjs --refresh）
  const scriptPath = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [scriptPath, '--refresh'], {
    detached: true, stdio: 'ignore', env: process.env,
  });
  child.unref();
}

// ─── 对外主入口 ───────────────────────────────────────────
export async function getQuota({ ttlMs = TTL_MS, nonBlocking = false } = {}) {
  const cache = readCache();
  const now = Date.now();
  const fresh = cache?.fetched_at && (now - cache.fetched_at) < ttlMs;
  if (fresh) return cache;

  if (!cache) {
    if (nonBlocking) {
      if (!isLocked()) spawnBackgroundRefresh();
      return { ok: false, fetched_at: 0, credential_status: 'loading', error: 'loading', tiers: [], extra_usage: null };
    }
    const r = await refreshWithLock();
    return r || { ok: false, fetched_at: 0, credential_status: 'unknown', error: 'locked_no_cache', tiers: [], extra_usage: null };
  }

  if (!isLocked()) spawnBackgroundRefresh();
  return cache;
}

// 模式判定：有 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY 即视为 API Billing 模式
export function isApiBilling(env = process.env) {
  return !!(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY);
}

// ─── 渲染 ─────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
};

function colorByUtil(u) {
  if (u >= 80) return C.red;
  if (u >= 60) return C.yellow;
  return C.green;
}

function formatDuration(targetIso) {
  if (!targetIso) return '';
  const t = Date.parse(targetIso);
  if (Number.isNaN(t)) return '';
  const ms = t - Date.now();
  if (ms <= 0) return 'now';
  const min = ms / 60000;
  if (min < 60) return `${Math.floor(min)}m`;          // <1h:  44m
  const h = min / 60;
  if (h < 24) return `${h.toFixed(1)}h`;                // <24h: 3.7h
  const d = h / 24;
  if (d < 10) return `${d.toFixed(1)}d`;                // <10d: 1.1d
  return `${Math.floor(d)}d`;                            // >=10d: 12d
}

const TIER_LABEL = {
  five_hour: '5h', seven_day: '7d',
  seven_day_opus: '7d-opus', seven_day_sonnet: '7d-sonnet',
};

const BAR_WIDTH = 8;

function renderBar(util, color) {
  const c = (clr, s) => color ? `${clr}${s}${C.reset}` : s;
  const u = Math.max(0, Math.min(100, util || 0));
  const filled = Math.floor(u / (100 / BAR_WIDTH));
  const clr = colorByUtil(u);
  const fillPart = filled > 0 ? c(clr, '█'.repeat(filled)) : '';
  const emptyPart = filled < BAR_WIDTH ? c(C.dim, '░'.repeat(BAR_WIDTH - filled)) : '';
  const pct = c(clr, `${Math.round(u).toString().padStart(3)}%`);
  return { bar: fillPart + emptyPart, pct };
}

function renderTier(name, tier, color) {
  const c = (clr, s) => color ? `${clr}${s}${C.reset}` : s;
  const { bar, pct } = renderBar(tier.utilization, color);
  const label = TIER_LABEL[name] || name;
  const dur = formatDuration(tier.resets_at);
  const tail = dur ? ` ${c(C.dim, dur)}` : '';
  return `${c(C.dim, label)} ${bar} ${pct}${tail}`;
}

// statusline 第四栏：5h + 7d 双进度条
export function formatUsageColumn(quota, { color = true } = {}) {
  const c = (clr, s) => color ? `${clr}${s}${C.reset}` : s;

  if (!quota || quota.credential_status === 'loading') return c(C.dim, '(loading)');
  if (quota.credential_status === 'expired' && (!quota.tiers || !quota.tiers.length)) {
    return c(C.red, 'auth expired');
  }

  const byName = Object.fromEntries((quota.tiers || []).map(t => [t.name, t]));
  const segs = [];
  for (const name of ['five_hour', 'seven_day']) {
    const t = byName[name];
    if (t) segs.push(renderTier(name, t, color));
  }

  if (segs.length === 0) {
    return c(C.dim, quota.error ? `quota:${String(quota.error).slice(0, 40)}` : 'quota:?');
  }

  let out = segs.join('  ');

  const e = quota.extra_usage;
  if (e?.is_enabled && typeof e.utilization === 'number' && e.utilization > 0) {
    out += '  ' + c(colorByUtil(e.utilization), `extra:${Math.round(e.utilization)}%`);
  }

  if (quota.stale) out += ' ' + c(C.dim, '(stale)');
  return out;
}

// 旧 CLI 用的简洁单行
export function formatStatusline(quota, { color = true } = {}) {
  const c = (clr, s) => color ? `${clr}${s}${C.reset}` : s;
  if (!quota || quota.credential_status === 'not_found') return c(C.dim, 'quota:no-cred');
  if (quota.credential_status === 'expired' && (!quota.tiers || !quota.tiers.length)) return c(C.red, 'quota:auth-expired');
  if (!quota.tiers?.length) return c(C.dim, quota.error ? `quota:${quota.error.slice(0, 30)}` : 'quota:?');

  const order = ['five_hour', 'seven_day'];
  const sorted = [...quota.tiers].sort((a, b) => {
    const ai = order.indexOf(a.name); const bi = order.indexOf(b.name);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
  const parts = sorted.filter(t => order.includes(t.name)).map(t => {
    const u = Math.round(t.utilization);
    const dur = formatDuration(t.resets_at);
    const us = c(colorByUtil(u), `${u}%`);
    return dur ? `${TIER_LABEL[t.name]}:${us}/${c(C.dim, dur)}` : `${TIER_LABEL[t.name]}:${us}`;
  });
  let out = parts.join(c(C.dim, ' | '));
  if (quota.stale) out += ' ' + c(C.dim, '(stale)');
  return out;
}

// ─── CLI（被后台 fork 调，也可手动跑） ───────────────────
export async function runCli(argv = process.argv.slice(2)) {
  const flag = argv[0];

  if (flag === '--refresh') {
    const r = await refreshWithLock();
    if (!r) process.exit(2);
    process.exit(r.ok ? 0 : 1);
  }

  if (flag === '--status') {
    const cache = readCache();
    const lockExists = (() => { try { fs.statSync(LOCK_DIR); return true; } catch { return false; } })();
    console.log(`platform   : ${process.platform}`);
    console.log(`cache file : ${CACHE_FILE}`);
    console.log(`lock dir   : ${LOCK_DIR} ${lockExists ? '[LOCKED]' : '[free]'}`);
    if (cache) {
      const ageSec = Math.floor((Date.now() - cache.fetched_at) / 1000);
      console.log(`last fetch : ${ageSec}s ago (${new Date(cache.fetched_at).toISOString()})`);
      console.log(`ok         : ${cache.ok}`);
      console.log(`cred status: ${cache.credential_status}`);
      if (cache.error) console.log(`error      : ${cache.error}`);
      console.log(`tiers      : ${(cache.tiers || []).map(t => `${t.name}=${t.utilization.toFixed(1)}%`).join(', ') || '(none)'}`);
      if (cache.extra_usage) console.log(`extra      : ${JSON.stringify(cache.extra_usage)}`);
    } else {
      console.log('last fetch : (no cache)');
    }
    return;
  }

  const quota = await getQuota();
  if (flag === '--json') {
    console.log(JSON.stringify(quota, null, 2));
    return;
  }
  console.log(formatStatusline(quota, { color: !process.env.NO_COLOR }));
}

// 入口判断：兼容 win32（路径分隔符与 file:// 的 drive-letter 三斜杠差异）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch(e => { console.error('quota error:', e.message); process.exit(1); });
}
