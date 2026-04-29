# Changelog

All notable changes to `cc-quota-bar`.

## 0.3.1 - 2026-04-29

### Added
- **Subagent (Task tool) token tracking.** Subagent transcripts at `<project>/<sessionId>/subagents/agent-*.jsonl` are now scanned incrementally per render (per-file byte offsets) and counted into the Session column with per-model attribution. So a Haiku-priced subagent costs Haiku rates, not Opus rates — Cost stays accurate for sessions that mix models.
- Per-file `sidechainOffsets` in the session state file (under `~/.cache/claude-statusline/state/`).

### Changed
- Session `out:` and total now reflect cumulative session output (`state.cumOutput`) instead of just the parent context window's `total_output_tokens`. Without this, subagent output would land in the state but never show in the UI.
- On first encounter of a session's subagent directory (fresh state, mid-session upgrade, or post-compaction), existing subagent files are anchored to their current EOF — no retroactive scan. Same semantics as the parent-session accumulator. New subagent files appearing later are scanned from byte 0.

### Fixed
- Byte-offset bookkeeping for non-ASCII transcripts: an early version mixed character indices and byte offsets, which truncated the scan mid-file on CJK content. Newline detection now runs over the raw `Buffer` (`0x0A`) so offsets stay byte-accurate.

## 0.3.0 - unreleased (folded into 0.3.1)

### Added
- **Cost column for API Billing mode** (Anthropic official models only). `lib/pricing.json` is hand-maintained from `platform.claude.com/docs/.../pricing` and preserves the 5-minute / 1-hour cache-write split. Cumulative cost is computed per session, broken down by model.
- Robust model-ID matching (`lib/pricing.mjs`): tolerates case, `~` prefix, `-YYYYMMDD` date suffixes, `.` ↔ `-` version separators, and `anthropic/` vendor prefixes — `claude-opus-4-7`, `claude-opus-4-7-20251029`, `claude-opus-4.7`, and `anthropic/claude-opus-4.7` all resolve to one entry.
- Mixed-session display: when some models in a session aren't in the pricing table, the line shows `$X.XX (partial)` instead of pretending to be exact. All-non-Anthropic sessions show `-- (not supported)`.

### Notes
- Other vendors (OpenRouter, Aliyun BaiLian, Z.ai, MiniMax, Ollama, etc.) are intentionally **not supported**: each gateway has its own rate that no third-party table matches, and a wrong number is worse than no number.

## 0.2.1

- Fixes / minor polish on the 0.2.0 install flow.

## 0.2.0

- npx-first install path.

## 0.1.0

- Initial implementation: 2×2 layout, subscription quota progress bars (5h / 7d windows).
