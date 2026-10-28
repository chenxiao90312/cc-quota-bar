// 智谱（BigModel 中国）订阅配额：Claude Code 挂 ZCode 端点时显示 5h/周限额
//
// 触发：ANTHROPIC_BASE_URL 指向 *.bigmodel.cn（由 statusline.mjs 判定后调用）
// 认证：Bearer <MaaS JWT>，取 ANTHROPIC_API_KEY（优先）或 ANTHROPIC_AUTH_TOKEN
// API  ：GET https://bigmodel.cn/api/monitor/usage/quota/limit
//        Bigmodel-Target-Type: PERSONAL
// 响应：data.limits[] 中 type=TOKENS_LIMIT 且 unit!==6 为 5h 窗口、unit===6 为
//        周窗口；percentage 为 0-100 整数；nextResetTime 为 epoch 毫秒。
//        归一化成与 Claude OAuth quota 同构的 payload（tiers + ISO resets_at），
//        直接复用 quota.mjs 的 formatUsageColumn 渲染。
//
// 缓存：~/.cache/claude-quota/zhipu-cache.json   TTL 60s
// 锁  ：~/.cache/claude-quota/zhipu-lock.d/      mkdir 原子锁，孤儿 2min 自清

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CACHE_DIR = path.join(os.homedir(), '.cache', 'claude-quota');
const CACHE_FILE = path.join(CACHE_DIR, 'zhipu-cache.json');
const LOCK_DIR = path.join(CACHE_DIR, 'zhipu-lock.d');

const TTL_MS = 60 * 1000;
const LOCK_ORPHAN_MS = 120 * 1000;
const HTTP_TIMEOUT_MS = 8 * 1000;

const QUOTA_API = 'https://bigmodel.cn/api/monitor/usage/quota/limit';

// ─── 环境判定（statusline 模式路由用） ────────────────────
export function isZhipuEnv(env = process.env) {
  const base = env.ANTHROPIC_BASE_URL;
  if (!base) return false;
  try { return new URL(base).hostname.endsWith('bigmodel.cn'); }
  catch { return false; }
}

// MaaS JWT：ANTHROPIC_API_KEY 优先于 ANTHROPIC_AUTH_TOKEN
export function zhipuToken(env = process.env) {
  return env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || null;
}

// ─── 调 BigModel API ──────────────────────────────────────
async function fetchZhipuQuota(token) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const resp = await fetch(QUOTA_API, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Bigmodel-Target-Type': 'PERSONAL',
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
    if (body?.code !== 200) {
      return { ok: false, errorCode: 'api_error', error: `code=${body?.code} ${String(body?.msg || '').slice(0, 120)}` };
    }
    return { ok: true, body };
  } catch (e) {
    return { ok: false, errorCode: 'network', error: e.name === 'AbortError' ? `timeout after ${HTTP_TIMEOUT_MS}ms` : e.message };
  } finally {
    clearTimeout(timer);
  }
}

// nextResetTime(epoch ms) → ISO；无效值归 null
function toIso(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
  const t = new Date(ms);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

// 归一化：limits[] → Claude 同构 tiers（five_hour / seven_day）
function parseZhipuBody(body) {
  const tiers = [];
  const limits = body?.data?.limits;
  if (Array.isArray(limits)) {
    for (const lim of limits) {
      if (lim?.type !== 'TOKENS_LIMIT' || typeof lim.percentage !== 'number') continue;
      const resetsAt = toIso(lim.nextResetTime);
      if (lim.unit === 6) {
        tiers.push({ name: 'seven_day', utilization: lim.percentage, resets_at: resetsAt });
      } else {
        tiers.push({ name: 'five_hour', utilization: lim.percentage, resets_at: resetsAt });
      }
    }
  }
  return { tiers };
}

// ─── 缓存读写（与 quota.mjs 同款模式，独立文件/锁） ──────
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
  const token = zhipuToken();
  if (!token) {
    const payload = {
      ok: false, fetched_at: Date.now(),
      credential_status: 'not_found', error: 'no ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN',
      tiers: [], extra_usage: null,
    };
    writeCache(payload);
    return payload;
  }

  const r = await fetchZhipuQuota(token);
  if (!r.ok) {
    const old = readCache();
    const payload = {
      ok: false, fetched_at: Date.now(),
      credential_status: r.errorCode === 'auth_expired' ? 'expired' : 'valid',
      error: r.error,
      tiers: old?.tiers || [], extra_usage: null,
      stale: true,
    };
    writeCache(payload);
    return payload;
  }

  const parsed = parseZhipuBody(r.body);
  const payload = {
    ok: true, fetched_at: Date.now(),
    credential_status: 'valid',
    tiers: parsed.tiers, extra_usage: null,
  };
  writeCache(payload);
  return payload;
}

// ─── 后台 fork ────────────────────────────────────────────
function spawnBackgroundRefresh() {
  const scriptPath = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [scriptPath, '--refresh'], {
    detached: true, stdio: 'ignore', env: process.env,
  });
  child.unref();
}

// ─── 对外主入口 ───────────────────────────────────────────
export async function getZhipuQuota({ ttlMs = TTL_MS, nonBlocking = false } = {}) {
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

// ─── CLI（被后台 fork 调，也可手动跑） ───────────────────
export async function runCli(argv = process.argv.slice(2)) {
  const flag = argv[0];

  if (flag === '--refresh') {
    const r = await refreshWithLock();
    if (!r) process.exit(2);
    process.exit(r.ok ? 0 : 1);
  }

  const quota = await getZhipuQuota();
  console.log(JSON.stringify(quota, null, 2));
}

// 入口判断：兼容 win32（路径分隔符与 file:// 的 drive-letter 三斜杠差异）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch(e => { console.error('zhipu quota error:', e.message); process.exit(1); });
}
