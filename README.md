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

**一条命令搞定**：

```bash
npx cc-quota-bar
```

背后做四件事：
1. 检查 Node ≥ 18
2. 把代码复制到 `~/.local/share/cc-quota-bar/`（XDG 标准稳定路径，与 npm cache 解耦，避免 cache GC 后 statusline 找不到入口）
3. 备份现有 `~/.claude/settings.json`（如有），写入 `statusLine.command` 指向稳定路径里的 `bin/statusline.mjs`
4. 跑一次烟雾测试，打印渲染结果

下次 Claude Code statusline 刷新即生效（不用重启 session，statusLine 每次刷新都重新执行）。

### 升级

```bash
npx cc-quota-bar       # 同一条命令，会用 npm 上的最新版覆盖稳定路径里的旧代码
```

`~/.claude/settings.json` 里的绝对路径不变，无需再次设置。

### 备选（不推荐）：全局安装

如果你坚持全局安装：

```bash
npm install -g cc-quota-bar    # 装包到全局 PATH
cc-quota-bar                    # 一次性 setup（仍会复制到稳定路径）
```

全局安装的副作用是占着 `claude-status-bar` / `claude-quota` 等命令名（PATH 污染）；npx 模式只占稳定目录，不污染 PATH。npm 全局安装的优势是 `claude-quota --status` 等调试命令直接可用，npx 模式调试要写完整路径。

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
# 1. 恢复 settings.json（时间戳替换成你那个）
mv ~/.claude/settings.json.bak.YYYY-MM-DDTHH-MM-SS-mmmZ ~/.claude/settings.json

# 2. 删除稳定路径下的代码副本
rm -rf ~/.local/share/cc-quota-bar

# 3. 清缓存（可选）
rm -rf ~/.cache/claude-quota ~/.cache/claude-statusline

# 4. 如果走过 npm install -g 路径，再跑一句卸载
npm uninstall -g cc-quota-bar
```

## 致谢

订阅 quota 查询 endpoint 与凭据读取协议来自对 [farion1231/cc-switch](https://github.com/farion1231/cc-switch) 的源码梳理。
