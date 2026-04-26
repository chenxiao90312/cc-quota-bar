#!/usr/bin/env node
// claude-quota: 独立 CLI（debug 用）

import { runCli } from '../lib/quota.mjs';

runCli().catch(e => {
  console.error('quota error:', e.message);
  process.exit(1);
});
