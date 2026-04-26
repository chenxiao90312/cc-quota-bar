# cc-quota-bar

Claude Code statusline，**订阅模式**下右栏用进度条展示官方 5 小时 / 7 天限速窗口；**API Billing 模式**（环境变量含 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`）下右栏自动切回 token 累计成本。

跨平台：Linux / macOS（macOS 优先读 Keychain，自动回退到 `~/.claude/.credentials.json`）。

## 渲染示例

订阅模式（默认）：

```
chenxiao@host /path/to/repo (main)
Model: opus-4-7 | Usage: 5h █░░░░░░░  18% 4.7h  7d ░░░░░░░░  12% 1.7h
Ctx: 88k(45%)   | Session: 98k in:85k/88k(96%) out:10k cacheW:2k
```

API Billing 模式：

```
chenxiao@host /path/to/repo (main)
Model: opus-4-7 | Cost: $0.4200
Ctx: 88k(45%)   | Session: 98k in:85k/88k(96%) out:10k cacheW:2k
```

进度条颜色阈值（按 utilization）：< 60% 绿、60–80% 黄、≥ 80% 红。

布局采用 2×2，便于半屏 terminal 阅读：左列 `Model / Ctx`，右列 `Usage|Cost / Session`，`|` 自动对齐。

## 安装

```bash
# 方式一：从 npm 安装
npm install -g cc-quota-bar

# 方式二：从源码安装（克隆仓库后）
cd cc-quota-bar
npm install -g .

# 一键写入 ~/.claude/settings.json
claude-status-bar-setup
```

setup 会做：
1. 检查 Node ≥ 18
2. 备份现有 `~/.claude/settings.json`（如有）
3. 写入 `statusLine.command` 指向 `bin/statusline.mjs`（解 symlink 后的真实绝对路径）
4. 跑一次烟雾测试，打印渲染结果

下次 Claude Code statusline 刷新即生效（不用重启 session，statusLine 是每次刷新时调用）。

升级后只需重跑 `npm install -g cc-quota-bar`（或源码方式 `npm install -g .`），bin 是 symlink，自动指向新代码，无需再跑 setup。

## 工作机制

- 凭据读取：macOS 走 `security find-generic-password -s "Claude Code-credentials"` Keychain；Linux 读 `~/.claude/.credentials.json`
- 调用 API：`GET https://api.anthropic.com/api/oauth/usage` + `anthropic-beta: oauth-2025-04-20`（与 Claude Code 自带的 `/usage` 命令同源）
- 缓存：`~/.cache/claude-quota/cache.json`，TTL 60 秒
- 锁：`~/.cache/claude-quota/lock.d/`，mkdir 原子锁，孤儿锁 2 分钟自动清理

频率与并发保证：
- 缓存命中（< 60s）：~18ms 同步返回，零 API 请求
- 缓存过期：立即返回旧值，后台 fork 异步刷新（statusline 不阻塞）
- 多个 Claude Code session 同时刷：mkdir 锁保证只有一个真打 API
- 401 / 403：写入缓存为 `expired`，1 分钟内不再重试，右栏显示 `auth expired`
- API 请求频率上限：≤ 1 次/分钟（实际更低，因为锁会进一步去重）

## 调试

```bash
claude-quota --status     # 缓存年龄、锁状态、最近一次结果
claude-quota --json       # 完整缓存 JSON
claude-quota --refresh    # 强制刷新一次（同步等结果）
```

## 卸载 / 回滚

setup 留下的 `~/.claude/settings.json.bak.<时间戳>` 可以直接覆盖回去：

```bash
mv ~/.claude/settings.json.bak.YYYY-MM-DDTHH-MM-SS-mmmZ ~/.claude/settings.json
npm uninstall -g cc-quota-bar
rm -rf ~/.cache/claude-quota ~/.cache/claude-statusline
```

## 致谢

订阅 quota 查询 endpoint 与凭据读取协议来自对 [farion1231/cc-switch](https://github.com/farion1231/cc-switch) 的源码梳理。
