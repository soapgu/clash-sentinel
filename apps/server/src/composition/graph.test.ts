import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerConfig } from '../config.js';
import { noopLogger, type AppLogger } from '../logging.js';
import { createAppContainer } from './container.js';
import { TOKENS } from './tokens.js';
import type { SqliteStore } from '../storage/store.js';
import type { TaskType } from '@clash-sentinel/shared';

/** 创建指向临时目录的测试环境变量，避免触碰真实状态和报告。 */
async function createTestEnvironment() {
  const root = await mkdtemp(join(tmpdir(), 'clash-container-'));
  const environment = {
    CLASH_SENTINEL_DB_PATH: join(root, 'container.db'),
    CLASH_SENTINEL_LEGACY_SCRIPT_PATH: join(root, 'legacy.sh'),
    CLASH_APP_DIR: join(root, 'clash'),
    CLASH_ENTRY_STATE_DIR: join(root, 'state'),
    CLASH_ENTRY_REPORT_DIR: join(root, 'reports'),
    CLASH_ENTRY_BACKUP_DIR: join(root, 'backups'),
    CLASH_RUNTIME_CONFIG: join(root, 'runtime.yaml'),
  };
  return { root, environment };
}

const TEST_CONFIG: ServerConfig = {
  logging: { redactSensitiveData: true },
  storage: { redactSensitiveData: true },
};

const cleanups: Array<{ root: string; store: SqliteStore }> = [];

afterEach(async () => {
  for (const item of cleanups.splice(0)) {
    item.store.close();
    await rm(item.root, { recursive: true, force: true });
  }
});

/** 构造使用临时目录和空日志器的完整测试容器。 */
async function createGraphContainer(logger: AppLogger = noopLogger) {
  const { root, environment } = await createTestEnvironment();
  const child = createAppContainer({
    environment,
    config: TEST_CONFIG,
    logger,
  });
  const store = child.resolve<SqliteStore>(TOKENS.sqliteStore);
  cleanups.push({ root, store });
  return { child, store, root };
}

describe('createAppContainer 依赖图', () => {
  it('可以解析完整服务图且注册表覆盖全部任务类型', () => {
    return createGraphContainer().then(({ child }) => {
      const store = child.resolve<SqliteStore>(TOKENS.sqliteStore);
      expect(store.settings).toBeTypeOf('object');
      // 六个仓储 token 均指向同一个 Store 实例的字段。
      expect(child.resolve(TOKENS.settingsRepository)).toBe(store.settings);
      expect(child.resolve(TOKENS.healthRepository)).toBe(store.health);
      expect(child.resolve(TOKENS.siteRepository)).toBe(store.sites);
      expect(child.resolve(TOKENS.diagnosisRepository)).toBe(store.diagnoses);
      expect(child.resolve(TOKENS.taskRepository)).toBe(store.tasks);
      expect(child.resolve(TOKENS.eventRepository)).toBe(store.events);

      const notifier = child.resolve(TOKENS.statusNotificationCenter);
      expect(notifier).toBeTypeOf('object');
      const registry = child.resolve(TOKENS.taskHandlerRegistry);
      const expected: TaskType[] = [
        'health_check',
        'diagnose',
        'apply',
        'reset',
        'rollback',
        'auto_switch',
      ];
      expect(Object.keys(registry).sort()).toEqual([...expected].sort());

      const taskEngine = child.resolve(TOKENS.taskEngine);
      const scheduler = child.resolve(TOKENS.healthScheduler);
      expect(taskEngine).toBeTypeOf('object');
      expect(scheduler).toBeTypeOf('object');
      expect(child.resolve(TOKENS.healthCheckService)).toBeTypeOf('object');
      expect(child.resolve(TOKENS.autoSwitchService)).toBeTypeOf('object');
      expect(child.resolve(TOKENS.legacyAdapter)).toBeTypeOf('object');
      expect(child.resolve(TOKENS.siteProbe)).toBeTypeOf('object');
      expect(child.resolve(TOKENS.clashProxyConfig)).toBeTypeOf('object');
    });
  });

  it('ContainerScoped 服务在同一 child 内保持相同实例', async () => {
    const { child } = await createGraphContainer();
    expect(child.resolve(TOKENS.taskEngine)).toBe(
      child.resolve(TOKENS.taskEngine),
    );
    expect(child.resolve(TOKENS.healthScheduler)).toBe(
      child.resolve(TOKENS.healthScheduler),
    );
    expect(child.resolve(TOKENS.healthCheckService)).toBe(
      child.resolve(TOKENS.healthCheckService),
    );
    expect(child.resolve(TOKENS.autoSwitchService)).toBe(
      child.resolve(TOKENS.autoSwitchService),
    );
    expect(child.resolve(TOKENS.sqliteStore)).toBe(
      child.resolve(TOKENS.sqliteStore),
    );
  });

  it('解析阶段不产生定时器副作用且调度器保持停止', async () => {
    const { child } = await createGraphContainer();
    const scheduler = child.resolve(TOKENS.healthScheduler);
    // getSnapshot 只读取设置，不启动定时器；解析本身也不安排任何轮次。
    expect(scheduler.getSnapshot().state).not.toBe('running');
  });

  it('child 中覆盖 sqliteStore 后仓储和引擎依赖随之切换', async () => {
    const { child } = await createGraphContainer();
    const replacement = new (await import('../storage/store.js')).SqliteStore(
      {},
    );
    child.register(TOKENS.sqliteStore, { useValue: replacement });
    expect(child.resolve(TOKENS.sqliteStore)).toBe(replacement);
    expect(child.resolve(TOKENS.settingsRepository)).toBe(replacement.settings);
    expect(child.resolve(TOKENS.taskRepository)).toBe(replacement.tasks);
    replacement.close();
  });

  it('两个 child container 的 Store 和引擎互不共享', async () => {
    const graphA = await createGraphContainer();
    const graphB = await createGraphContainer();
    expect(graphA.store).not.toBe(graphB.store);
    expect(graphA.child.resolve(TOKENS.taskEngine)).not.toBe(
      graphB.child.resolve(TOKENS.taskEngine),
    );
    expect(graphA.child.resolve(TOKENS.healthScheduler)).not.toBe(
      graphB.child.resolve(TOKENS.healthScheduler),
    );
  });

  it('解析完整图不触发 Legacy 子进程或网络探测', async () => {
    const { child } = await createGraphContainer();
    const adapter = child.resolve(TOKENS.legacyAdapter);
    const probe = child.resolve(TOKENS.siteProbe);
    // 只验证类型边界；不调用任何会发起子进程或网络的方法。
    expect(typeof adapter.getStatus).toBe('function');
    expect(typeof probe.probe).toBe('function');
  });
});
