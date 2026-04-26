<p align="right">
  <strong>English</strong> |
  <a href="https://github.com/chenxiao90312/cc-quota-bar/blob/main/README.zh-CN.md">简体中文</a>
</p>

# cc-quota-bar

A Claude Code statusline that surfaces your **official 5-hour / 7-day subscription quota** as progress bars in the right column. When you're on **API Billing mode** (`ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` set in your env), it automatically switches the right column to a cumulative token cost reference.

Cross-platform: Linux / macOS (on macOS the OAuth token is read from Keychain first, falling back to `~/.claude/.credentials.json`).

## Render examples

Subscription mode (default):

```
chenxiao@host /path/to/repo (main)
Model: opus-4-7 | Usage: 5h █░░░░░░░  18% 4.7h  7d ░░░░░░░░  12% 1.7h
Ctx: 88k(45%)   | Session: 98k in:85k/88k(96%) out:10k cacheW:2k
```

API Billing mode:

```
chenxiao@host /path/to/repo (main)
Model: opus-4-7 | Cost: $0.4200
Ctx: 88k(45%)   | Session: 98k in:85k/88k(96%) out:10k cacheW:2k
```

Progress-bar color thresholds (by utilization): **< 60% green, 60–80% yellow, ≥ 80% red**.

The 2×2 layout is optimized for half-screen terminals: left column is `Model / Ctx`, right column is `Usage|Cost / Session`, with the `|` separator auto-aligned across rows.

## Install

**One command does everything:**

```bash
npx cc-quota-bar
```

It performs four steps:
1. Checks Node ≥ 18
2. Copies the package files into `~/.local/share/cc-quota-bar/` (XDG-standard stable path, decoupled from npm's cache so the statusline runner survives cache GC and npm version churn)
3. Backs up your existing `~/.claude/settings.json` (if any) and writes `statusLine.command` to point at the stable-path `bin/statusline.mjs`
4. Runs a smoke render and prints the result

Effective on the next Claude Code statusline refresh — no session restart needed (statusLine is re-executed every refresh).

### Upgrade

```bash
npx cc-quota-bar       # Same command — pulls latest from npm and overwrites the stable-path copy
```

The absolute path inside `~/.claude/settings.json` doesn't change, so no re-configuration is needed.

### Alternative: global install (not recommended)

If you'd rather install globally:

```bash
npm install -g cc-quota-bar    # installs the bin entries onto your global PATH
cc-quota-bar                    # one-time setup (still copies to the stable path)
```

Global install pollutes `$PATH` with `claude-status-bar` / `claude-quota` / etc. The npx flow only occupies the stable directory and leaves your `$PATH` clean. The trade-off: with the global install you can run debug commands like `claude-quota --status` directly; under npx you'd need the full path.

## How it works

- **Credentials**: macOS reads from Keychain (`security find-generic-password -s "Claude Code-credentials"`); Linux reads `~/.claude/.credentials.json`
- **API**: `GET https://api.anthropic.com/api/oauth/usage` with header `anthropic-beta: oauth-2025-04-20` — same endpoint as Claude Code's built-in `/usage` slash command
- **Cache**: `~/.cache/claude-quota/cache.json`, 60-second TTL
- **Lock**: `~/.cache/claude-quota/lock.d/`, atomic `mkdir`-based, orphan locks self-clear after 2 minutes

Concurrency & rate guarantees:
- Cache hit (< 60s): ~18 ms synchronous return, **zero API requests**
- Cache stale: returns the old value immediately, forks a background refresh (statusline never blocks)
- Multiple concurrent Claude Code sessions: the `mkdir` lock ensures only **one** session actually hits the API; others read the freshly-written cache
- 401 / 403: written to cache as `expired`, no retry within 1 minute, right column shows `auth expired`
- Effective request rate: **≤ 1 / minute** (often lower, since the lock further dedupes)

## Debug

```bash
claude-quota --status     # cache age, lock state, last result
claude-quota --json       # full cache JSON
claude-quota --refresh    # force a synchronous refresh
```

## Uninstall / rollback

The setup script leaves a `~/.claude/settings.json.bak.<timestamp>` you can restore directly:

```bash
# 1. Restore the original settings.json (replace the timestamp with yours)
mv ~/.claude/settings.json.bak.YYYY-MM-DDTHH-MM-SS-mmmZ ~/.claude/settings.json

# 2. Remove the stable-path copy
rm -rf ~/.local/share/cc-quota-bar

# 3. Clear caches (optional)
rm -rf ~/.cache/claude-quota ~/.cache/claude-statusline

# 4. If you also ran `npm install -g`, uninstall the global copy
npm uninstall -g cc-quota-bar
```

## Credits

The subscription quota endpoint and credential-read protocol were learned by reading the source of [farion1231/cc-switch](https://github.com/farion1231/cc-switch).
