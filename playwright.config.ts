import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const isolatedRoot = mkdtempSync(join(tmpdir(), 'clash-sentinel-e2e-'));
const e2ePort = '4312';
const baseURL = `http://127.0.0.1:${e2ePort}`;

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  use: { baseURL, trace: 'retain-on-failure' },
  reporter: [['list'], ['html', { open: 'never' }]],
  webServer: {
    command: 'npm start',
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    env: {
      NODE_ENV: 'test',
      CLASH_SENTINEL_PORT: e2ePort,
      CLASH_SENTINEL_DB_PATH: join(isolatedRoot, 'sentinel.db'),
      CLASH_APP_DIR: join(isolatedRoot, 'clash'),
      CLASH_RUNTIME_CONFIG: join(isolatedRoot, 'clash', 'clash-verge.yaml'),
      CLASH_ENTRY_STATE_DIR: join(isolatedRoot, 'legacy-state'),
      CLASH_ENTRY_REPORT_DIR: join(isolatedRoot, 'legacy-reports'),
      CLASH_ENTRY_BACKUP_DIR: join(isolatedRoot, 'legacy-backups'),
    },
  },
});
