import type { AppLogger } from '../logging.js';
import type { ServerConfig } from '../config.js';
import type { RuntimePaths } from '../project-paths.js';
import type { SettingsRepository } from '../storage/settings-repository.js';
import type { HealthRepository } from '../storage/health-repository.js';
import type { SiteRepository } from '../storage/site-repository.js';
import type { DiagnosisRepository } from '../storage/diagnosis-repository.js';
import type { TaskRepository } from '../storage/task-repository.js';
import type { EventRepository } from '../storage/event-repository.js';
import type { SqliteStore } from '../storage/store.js';
import type { LegacyAdapter } from '../legacy/adapter.js';
import type { StatusNotificationCenter } from '../services/status-notifier.js';
import type { SiteProbe } from '../services/health/site-probe.js';
import type { ClashProxyConfig } from '../services/health/proxy-config.js';
import type { HealthCheckService } from '../services/health/health-check.js';
import type { HealthScheduler } from '../services/health/health-scheduler.js';
import type { AutoSwitchService } from '../services/auto-switch/auto-switch-service.js';
import type { TaskEngine } from '../services/tasks/task-engine.js';
import type { TaskHandlerRegistry } from '../services/tasks/contracts.js';

/**
 * 运行时依赖装配使用的集中 Symbol token。
 *
 * 所有容器注入的构造参数均通过 `@inject(TOKENS.xxx)` 显式声明，
 * 不依赖 `emitDecoratorMetadata` 反射元数据；token 统一注册完整实例，
 * 依赖收窄由各构造参数的 `Pick<>` 类型标注在编译期完成。
 */
export const TOKENS = {
  /** 服务端统一日志器。 */
  appLogger: Symbol('AppLogger'),
  /** 进程环境变量。 */
  processEnv: Symbol('ProcessEnv'),
  /** 启动配置。 */
  serverConfig: Symbol('ServerConfig'),
  /** 运行路径集合。 */
  runtimePaths: Symbol('RuntimePaths'),
  /** Unix 毫秒时钟。 */
  clock: Symbol('Clock'),
  /** Date 对象时钟。 */
  dateClock: Symbol('DateClock'),
  /** SQLite 数据访问门面。 */
  sqliteStore: Symbol('SqliteStore'),
  /** 设置仓储。 */
  settingsRepository: Symbol('SettingsRepository'),
  /** 健康快照仓储。 */
  healthRepository: Symbol('HealthRepository'),
  /** 站点历史仓储。 */
  siteRepository: Symbol('SiteRepository'),
  /** 诊断摘要仓储。 */
  diagnosisRepository: Symbol('DiagnosisRepository'),
  /** 任务仓储。 */
  taskRepository: Symbol('TaskRepository'),
  /** 事件仓储。 */
  eventRepository: Symbol('EventRepository'),
  /** Legacy Shell 适配器。 */
  legacyAdapter: Symbol('LegacyAdapter'),
  /** SSE 通知中心。 */
  statusNotificationCenter: Symbol('StatusNotificationCenter'),
  /** 六站 HTTP 探测器。 */
  siteProbe: Symbol('SiteProbe'),
  /** Clash 运行配置代理端口读取器。 */
  clashProxyConfig: Symbol('ClashProxyConfig'),
  /** 健康检测编排器。 */
  healthCheckService: Symbol('HealthCheckService'),
  /** 定时健康调度器。 */
  healthScheduler: Symbol('HealthScheduler'),
  /** 自动切换服务。 */
  autoSwitchService: Symbol('AutoSwitchService'),
  /** 任务引擎。 */
  taskEngine: Symbol('TaskEngine'),
  /** 不可变任务 Handler 注册表。 */
  taskHandlerRegistry: Symbol('TaskHandlerRegistry'),
  /** HTTP 监听端口与主机。 */
  httpListen: Symbol('HttpListen'),
} as const;

/** token 的值类型映射，供容器注册和测试构造复用。 */
export interface TokenTypes {
  [TOKENS.appLogger]: AppLogger;
  [TOKENS.processEnv]: NodeJS.ProcessEnv;
  [TOKENS.serverConfig]: ServerConfig;
  [TOKENS.runtimePaths]: RuntimePaths;
  [TOKENS.clock]: () => number;
  [TOKENS.dateClock]: () => Date;
  [TOKENS.sqliteStore]: SqliteStore;
  [TOKENS.settingsRepository]: SettingsRepository;
  [TOKENS.healthRepository]: HealthRepository;
  [TOKENS.siteRepository]: SiteRepository;
  [TOKENS.diagnosisRepository]: DiagnosisRepository;
  [TOKENS.taskRepository]: TaskRepository;
  [TOKENS.eventRepository]: EventRepository;
  [TOKENS.legacyAdapter]: LegacyAdapter;
  [TOKENS.statusNotificationCenter]: StatusNotificationCenter;
  [TOKENS.siteProbe]: SiteProbe;
  [TOKENS.clashProxyConfig]: ClashProxyConfig;
  [TOKENS.healthCheckService]: HealthCheckService;
  [TOKENS.healthScheduler]: HealthScheduler;
  [TOKENS.autoSwitchService]: AutoSwitchService;
  [TOKENS.taskEngine]: TaskEngine;
  [TOKENS.taskHandlerRegistry]: TaskHandlerRegistry;
  [TOKENS.httpListen]: { port: number; host: string };
}
