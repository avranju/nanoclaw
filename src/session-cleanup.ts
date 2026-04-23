import { execFile } from 'child_process';
import path from 'path';

import { log } from './log.js';

const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
const SCRIPT_PATH = path.resolve(process.cwd(), 'scripts/cleanup-sessions.sh');

function runCleanup(): void {
  execFile('/bin/bash', [SCRIPT_PATH], { timeout: 60_000 }, (err, stdout) => {
    if (err) {
      log.error('Session cleanup failed', { err });
      return;
    }
    const summary = stdout.trim().split('\n').pop();
    if (summary) log.info(summary);
  });
}

export function startSessionCleanup(): void {
  // Run once at startup (delayed 30s to not compete with init)
  setTimeout(runCleanup, 30_000);
  // Then every 24 hours
  setInterval(runCleanup, CLEANUP_INTERVAL);
}
