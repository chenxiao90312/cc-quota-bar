# claude-status-bar

Claude Code statusline，第四栏在订阅模式下显示官方 5 小时 / 7 天限速窗口的进度条；在 API Billing 模式下自动切回 token 累计成本（Cost Ref）。

跨平台：Linux / macOS（macOS 优先读 Keychain，自动回退到 `~/.claude/.credentials.json`）。

## 渲染示例

订阅模式（无 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`）：

```
chenxiao@host /path/to/repo (main)
Model    | Context      | Session                                | Usage
opus-4-7 | ctx:88k(45%) | total:120k in:90k/110k(82%) out:10k    | 5h ███░░░░░░░  31% 3h44m  7d ░░░░░░░░░░   3% 1d3h
```

API Billing 模式（环境变量里有 token）：

```
opus-4-7 | ctx:88k(45%) | total:... | $0.42
```

颜色阈值（按 utilization）：< 60% 绿，60–80% 黄，≥ 80% 红。

## 安装

仅本地安装，不发布到 npm registry。把整个 `status-bar/` 目录同步到目标机器，然后：

```bash
cd status-bar
npm install -g .              # 把 bin 链接到全局 PATH（注意末尾的点）
claude-status-bar-setup       # 一键写入 ~/.claude/settings.json
```

setup 会做：
1. 检查 Node ≥ 18
2. 备份现有 `~/.claude/settings.json`（如有）
3. 写入 `statusLine.command` 指向 `bin/statusline.mjs`（解 symlink 后的真实绝对路径）
4. 跑一次烟雾测试，打印渲染结果

下次开 Claude Code session 即可看到效果（不用重启 session，`statusLine` 是每次刷新时调用）。

升级源码后只需重跑 `npm install -g .`，bin 是 symlink，自动指向新代码，无需再跑 setup。

## 工作机制

- 凭据读取：macOS 走 `security find-generic-password -s "Claude Code-credentials"` Keychain；Linux 读 `~/.claude/.credentials.json`
- 调用 API：`GET https://api.anthropic.com/api/oauth/usage` + `anthropic-beta: oauth-2025-04-20`（与 Claude Code 自带的 `/usage` 命令同源）
- 缓存：`~/.cache/claude-quota/cache.json`，TTL 60 秒
- 锁：`~/.cache/claude-quota/lock.d/`，mkdir 原子锁，孤儿锁 2 分钟自动清理

频率与并发保证：
- 缓存命中（< 60s）：~18ms 同步返回，零 API 请求
- 缓存过期：立即返回旧值，后台 fork 异步刷新（statusline 不阻塞）
- 多个 Claude Code session 同时刷：mkdir 锁保证只有一个真打 API
- 401/403：写入缓存为 `expired`，1 分钟内不再重试，第四栏显示 `auth expired`
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
npm uninstall -g claude-status-bar
rm -rf ~/.cache/claude-quota ~/.cache/claude-statusline
```

## 致谢

订阅 quota 查询 endpoint 与凭据读取协议来自对 [farion1231/cc-switch](https://github.com/farion1231/cc-switch) 的源码梳理。
