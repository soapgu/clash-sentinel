import { describe, expect, it } from 'vitest';
import { createIsolatedContainer } from '../../test-support/container.js';
import { TOKENS } from './tokens.js';
import type { SqliteStore } from '../storage/store.js';
import type { HealthScheduler } from '../services/health/health-scheduler.js';
import type { TaskType } from '@clash-sentinel/shared';
import type { TaskHandlerRegistry } from '../services/tasks/contracts.js';
import type { LegacyAdapter } from '../legacy/adapter.js';
import type { SiteProbe } from '../services/health/site-probe.js';

describe('createAppContainer 依赖图', () => {
  it('可以解析完整服务图且注册表覆盖全部任务类型', async () => {
    const { child } = await createIsolatedContainer();
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
    const registry = child.resolve<TaskHandlerRegistry>(
      TOKENS.taskHandlerRegistry,
    );
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

  it('ContainerScoped 服务在同一 child 内保持相同实例', async () => {
    const { child } = await createIsolatedContainer();
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
    const { child } = await createIsolatedContainer();
    const scheduler = child.resolve<HealthScheduler>(TOKENS.healthScheduler);
    // getSnapshot 只读取设置，不启动定时器；解析本身也不安排任何轮次。
    expect(scheduler.getSnapshot().state).not.toBe('running');
  });

  it('child 中覆盖 sqliteStore 后仓储和引擎依赖随之切换', async () => {
    const { child } = await createIsolatedContainer();
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
    const graphA = await createIsolatedContainer();
    const graphB = await createIsolatedContainer();
    expect(graphA.store).not.toBe(graphB.store);
    expect(graphA.child.resolve(TOKENS.taskEngine)).not.toBe(
      graphB.child.resolve(TOKENS.taskEngine),
    );
    expect(graphA.child.resolve(TOKENS.healthScheduler)).not.toBe(
      graphB.child.resolve(TOKENS.healthScheduler),
    );
  });

  it('解析完整图不触发 Legacy 子进程或网络探测', async () => {
    const { child } = await createIsolatedContainer();
    const adapter = child.resolve<LegacyAdapter>(TOKENS.legacyAdapter);
    const probe = child.resolve<SiteProbe>(TOKENS.siteProbe);
    // 只验证类型边界；不调用任何会发起子进程或网络的方法。
    expect(typeof adapter.getStatus).toBe('function');
    expect(typeof probe.probe).toBe('function');
  });
});
