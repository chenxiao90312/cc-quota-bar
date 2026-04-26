// 兼容入口：重新导出 lib/quota.mjs 的命名导出。
// 历史上 ~/.claude/scripts/statusline.mjs 用 file:///.../status-bar/quota.mjs 引用。
// 真正的实现在 ./lib/quota.mjs。
export * from './lib/quota.mjs';
