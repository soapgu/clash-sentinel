import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  DEFAULT_PROJECT_ROOT,
  projectRootFromModuleUrl,
  resolveRuntimePaths,
} from './project-paths.js';
import { resolveDatabasePath } from './storage/connection.js';

describe('服务端项目路径', () => {
  test('src 与 dist 模块位置回溯到相同仓库根目录', () => {
    const root = '/opt/clash-sentinel';
    expect(
      projectRootFromModuleUrl(`file://${root}/apps/server/src/runtime.ts`),
    ).toBe(root);
    expect(
      projectRootFromModuleUrl(`file://${root}/apps/server/dist/runtime.js`),
    ).toBe(root);
  });

  test('默认路径全部锚定真实项目根目录且 Legacy 脚本存在', () => {
    const paths = resolveRuntimePaths({});
    expect(paths.projectRoot).toBe(DEFAULT_PROJECT_ROOT);
    expect(paths.databasePath).toBe(
      join(DEFAULT_PROJECT_ROOT, '.state/clash-sentinel.db'),
    );
    expect(paths.legacyStateDir).toBe(
      join(DEFAULT_PROJECT_ROOT, '.state/legacy'),
    );
    expect(paths.legacyReportDir).toBe(
      join(DEFAULT_PROJECT_ROOT, 'reports/legacy'),
    );
    expect(existsSync(paths.legacyScriptPath)).toBe(true);
  });

  test('环境变量保持最高优先级且相对值基于项目根目录', () => {
    const root = '/tmp/project-root';
    const paths = resolveRuntimePaths(
      {
        CLASH_SENTINEL_DB_PATH: 'custom/data.db',
        CLASH_SENTINEL_LEGACY_SCRIPT_PATH: 'custom/legacy.sh',
        CLASH_APP_DIR: 'custom/clash',
        CLASH_ENTRY_STATE_DIR: 'custom/state',
        CLASH_ENTRY_REPORT_DIR: 'custom/reports',
        CLASH_ENTRY_BACKUP_DIR: 'custom/backups',
        CLASH_RUNTIME_CONFIG: 'custom/runtime.yaml',
      },
      root,
    );
    expect(paths).toEqual({
      projectRoot: root,
      databasePath: `${root}/custom/data.db`,
      legacyScriptPath: `${root}/custom/legacy.sh`,
      appDir: `${root}/custom/clash`,
      legacyStateDir: `${root}/custom/state`,
      legacyReportDir: `${root}/custom/reports`,
      legacyBackupDir: `${root}/custom/backups`,
      runtimeConfigPath: `${root}/custom/runtime.yaml`,
    });
  });

  test('SqliteStore 默认与相对配置不依赖进程 cwd', () => {
    const root = '/tmp/project-root';
    expect(resolveDatabasePath({ projectRoot: root }, {})).toBe(
      `${root}/.state/clash-sentinel.db`,
    );
    expect(
      resolveDatabasePath(
        { databasePath: 'custom/database.db', projectRoot: root },
        {},
      ),
    ).toBe(`${root}/custom/database.db`);
    expect(resolveDatabasePath({ databasePath: ':memory:' }, {})).toBe(
      ':memory:',
    );
  });
});
