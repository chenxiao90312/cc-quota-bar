// 计价表 + 模型 ID 匹配 + cost 计算
//
// 范围：仅 Anthropic 官方价（API Billing 模式下用户直连 Anthropic 才会走到这条路径）。
// 其他中转/聚合（OpenRouter、bailian、zai 等）不在覆盖内：中转商真实计费跟任何
// 第三方报价表都不一致，匹配上一个不准的价比标 "?" 更容易误导用户。
//
// 数据：lib/pricing.json 仅保留 anthropic 段（手写，源自 platform.claude.com/docs/.../pricing）
//
// 匹配顺序（命中即返回）：
//   1. raw 精确
//   2. lowercase + 去 ~ 前缀
//   3. 去日期后缀 (-YYYYMMDD)
//   4. 去 vendor 前缀（anthropic/claude-opus-4.7 → claude-opus-4.7）
//   5. dot ↔ dash 互换（4-7 ↔ 4.7）—— Claude 自家命名两种都见
//   6. 子串兜底（按 anthropic key 长度从长到短）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRICING_PATH = path.join(__dirname, 'pricing.json');

let _data = null;
function load() {
  if (_data) return _data;
  try {
    _data = JSON.parse(fs.readFileSync(PRICING_PATH, 'utf8'));
  } catch {
    _data = { anthropic: {}, _meta: { error: 'pricing.json missing' } };
  }
  return _data;
}

function* candidateKeys(modelId) {
  const id = String(modelId || '');
  if (!id) return;
  const seen = new Set();
  const yieldUnique = function* (k) {
    if (k && !seen.has(k)) { seen.add(k); yield k; }
  };

  yield* yieldUnique(id);

  const lower = id.toLowerCase().replace(/^~/, '');
  yield* yieldUnique(lower);

  const noDate = lower.replace(/-\d{8}$/, '');
  yield* yieldUnique(noDate);

  const slash = lower.indexOf('/');
  const tail = slash > 0 ? lower.slice(slash + 1) : null;
  if (tail) yield* yieldUnique(tail);
  const tailNoDate = tail ? tail.replace(/-\d{8}$/, '') : null;
  if (tailNoDate) yield* yieldUnique(tailNoDate);

  // dot ↔ dash 互换（Claude 自家 ID 两种格式都出现：claude-opus-4-7 vs claude-opus-4.7）
  for (const base of [lower, noDate, tail, tailNoDate]) {
    if (!base) continue;
    if (base.includes('.')) yield* yieldUnique(base.replace(/\./g, '-'));
    yield* yieldUnique(base.replace(/-(\d+)-(\d+)/g, '-$1.$2'));
  }
}

let _anthropicKeysSorted = null;
function anthropicSubstring(modelIdLower, data) {
  if (!_anthropicKeysSorted) {
    _anthropicKeysSorted = Object.keys(data.anthropic).sort((a, b) => b.length - a.length);
  }
  for (const k of _anthropicKeysSorted) {
    if (modelIdLower.includes(k)) return { rate: data.anthropic[k], displayKey: k };
  }
  return null;
}

export function findPricing(modelId) {
  const data = load();
  for (const k of candidateKeys(modelId)) {
    if (data.anthropic[k]) return { rate: data.anthropic[k], displayKey: k };
  }
  const lower = String(modelId || '').toLowerCase().replace(/^~/, '');
  return anthropicSubstring(lower, data);
}

// bucket: { uncached, cacheRead, cacheWrite5m, cacheWrite1h, output }
// rate:   { input, output, cacheRead, cacheWrite5m, cacheWrite1h }
export function calcCost(bucket, rate) {
  if (!rate) return 0;
  const M = 1_000_000;
  return ((bucket.uncached || 0) * (rate.input || 0)
    + (bucket.cacheRead || 0) * (rate.cacheRead || 0)
    + (bucket.cacheWrite5m || 0) * (rate.cacheWrite5m || 0)
    + (bucket.cacheWrite1h || 0) * (rate.cacheWrite1h || 0)
    + (bucket.output || 0) * (rate.output || 0)) / M;
}

export function getMeta() { return load()._meta || {}; }
