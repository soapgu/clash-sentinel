import 'reflect-metadata';
import {
  container,
  instanceCachingFactory,
  Lifecycle,
  type DependencyContainer,
} from 'tsyringe';
import { resolveRuntimePaths, type RuntimePaths } from '../project-paths.js';
import { createAppLogger, type AppLogger } from '../logging.js';
import { loadServerConfig, type ServerConfig } from '../config.js';
import { TOKENS } from './tokens.js';
import { SqliteStore } from '../storage/store.js';
import { LegacyAdapter } from '../legacy/adapter.js';
import { ClashProxyConfig } from '../services/health/proxy-config.js';
import { HealthCheckService } from '../services/health/health-check.js';
import { HealthScheduler } from '../services/health/health-scheduler.js';
import { UndiciSiteProbe } from '../services/health/site-probe.js';
import { StatusNotificationCenter } from '../services/status-notifier.js';
import { TaskEngine } from '../services/tasks/task-engine.js';
import { AutoSwitchService } from '../services/auto-switch/auto-switch-service.js';
import { ApplyTaskHandler } from '../services/tasks/handlers/apply-task-handler.js';
import { AutoSwitchTaskHandler } from '../services/tasks/handlers/auto-switch-task-handler.js';
import { DiagnoseTaskHandler } from '../services/tasks/handlers/diagnose-task-handler.js';
import { HealthCheckTaskHandler } from '../services/tasks/handlers/health-check-task-handler.js';
import { ResetTaskHandler } from '../services/tasks/handlers/reset-task-handler.js';
import { RollbackTaskHandler } from '../services/tasks/handlers/rollback-task-handler.js';
import type { TaskHandlerRegistry } from '../services/tasks/contracts.js';

/** 创建应用 child container 的输入，默认值与生产启动行为一致。 */
export interface CreateAppContainerOptions {
  /** 运行环境变量，测试可注入独立配置。 */
  environment?: NodeJS.ProcessEnv;
  /** 项目根目录，默认由当前模块位置推导而非进程 cwd。 */
  projectRoot?: string;
  /** 已加载的启动配置；缺省时按环境变量读取。 */
  config?: ServerConfig;
  /** 已创建的日志器；缺省时按配置创建 Console 日志器。 */
  logger?: AppLogger;
}

/**
 * 在 child container 中注册值依赖和全部进程级服务。
 *
 * 服务实现统一以 `Lifecycle.ContainerScoped` 语义注册：类注册使用
 * `ContainerScoped`，带特殊参数的对象使用 `instanceCachingFactory`，
 * 保证同一 child 内单例且不同 child 之间互不共享。
 */
function registerServices(
  child: DependencyContainer,
  environment: NodeJS.ProcessEnv,
  config: ServerConfig,
  logger: AppLogger,
): DependencyContainer {
  const paths = child.resolve<RuntimePaths>(TOKENS.runtimePaths);

  child.register(TOKENS.sqliteStore, {
    useFactory: instanceCachingFactory(
      () =>
        new SqliteStore({
          databasePath: paths.databasePath,
          logger,
          redactSensitiveData: config.storage.redactSensitiveData,
        }),
    ),
  });
  child.register(TOKENS.legacyAdapter, {
    useFactory: instanceCachingFactory(
      () =>
        new LegacyAdapter({
          scriptPath: paths.legacyScriptPath,
          appDir: paths.appDir,
          stateDir: paths.legacyStateDir,
          reportDir: paths.legacyReportDir,
          backupDir: paths.legacyBackupDir,
          environment,
          logger,
        }),
    ),
  });
  child.register(TOKENS.clashProxyConfig, {
    useFactory: instanceCachingFactory(
      () => new ClashProxyConfig(paths.runtimeConfigPath),
    ),
  });
  child.register(TOKENS.statusNotificationCenter, {
    useFactory: instanceCachingFactory(
      () =>
        new StatusNotificationCenter(
          child.resolve(TOKENS.dateClock),
          child.resolve(TOKENS.appLogger),
        ),
    ),
  });
  child.register(
    TOKENS.siteProbe,
    { useClass: UndiciSiteProbe },
    { lifecycle: Lifecycle.ContainerScoped },
  );
  child.register(
    TOKENS.autoSwitchService,
    { useClass: AutoSwitchService },
    { lifecycle: Lifecycle.ContainerScoped },
  );
  child.register(
    TOKENS.healthCheckService,
    { useClass: HealthCheckService },
    { lifecycle: Lifecycle.ContainerScoped },
  );
  child.register(
    TOKENS.taskEngine,
    { useClass: TaskEngine },
    { lifecycle: Lifecycle.ContainerScoped },
  );
  child.register(
    TOKENS.healthScheduler,
    { useClass: HealthScheduler },
    { lifecycle: Lifecycle.ContainerScoped },
  );
  child.register(TOKENS.taskHandlerRegistry, {
    useFactory: instanceCachingFactory((c) => {
      const registry: TaskHandlerRegistry = {
        health_check: c.resolve(HealthCheckTaskHandler),
        diagnose: c.resolve(DiagnoseTaskHandler),
        apply: c.resolve(ApplyTaskHandler),
        reset: c.resolve(ResetTaskHandler),
        rollback: c.resolve(RollbackTaskHandler),
        auto_switch: c.resolve(AutoSwitchTaskHandler),
      };
      return registry;
    }),
  });

  registerRepositories(child);
  return child;
}

/** 注册六个领域仓储 token，均指向同一个 SqliteStore 的实例字段。 */
function registerRepositories(child: DependencyContainer): void {
  const store = () => child.resolve<SqliteStore>(TOKENS.sqliteStore);
  child.register(TOKENS.settingsRepository, {
    useFactory: instanceCachingFactory(() => store().settings),
  });
  child.register(TOKENS.healthRepository, {
    useFactory: instanceCachingFactory(() => store().health),
  });
  child.register(TOKENS.siteRepository, {
    useFactory: instanceCachingFactory(() => store().sites),
  });
  child.register(TOKENS.diagnosisRepository, {
    useFactory: instanceCachingFactory(() => store().diagnoses),
  });
  child.register(TOKENS.taskRepository, {
    useFactory: instanceCachingFactory(() => store().tasks),
  });
  child.register(TOKENS.eventRepository, {
    useFactory: instanceCachingFactory(() => store().events),
  });
}

/**
 * 创建注册了环境、配置、日志器、运行路径和全部服务的应用 child container。
 *
 * 默认容器只作为父容器和元数据入口；业务模块不得直接访问默认容器
 * 或在此之外的任何容器。服务解析为惰性构造，解析阶段除 SQLite 外
 * 不产生网络连接或定时器副作用；启动恢复由应用根在 start 阶段编排。
 *
 * @returns 可独立解析与释放的 child container。
 */
export function createAppContainer(
  options: CreateAppContainerOptions = {},
): DependencyContainer {
  const environment = options.environment ?? process.env;
  const config =
    options.config ?? loadServerConfig(environment, options.projectRoot);
  const logger =
    options.logger ??
    createAppLogger({
      environment,
      redactSensitiveData: config.logging.redactSensitiveData,
    });
  const child = container.createChildContainer();
  child.register(TOKENS.processEnv, { useValue: environment });
  child.register(TOKENS.serverConfig, { useValue: config });
  child.register(TOKENS.appLogger, { useValue: logger });
  child.register(TOKENS.runtimePaths, {
    useValue: resolveRuntimePaths(environment, options.projectRoot),
  });
  child.register(TOKENS.clock, { useValue: Date.now });
  child.register(TOKENS.dateClock, { useValue: () => new Date() });
  return registerServices(child, environment, config, logger);
}
