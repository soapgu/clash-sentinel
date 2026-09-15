import 'reflect-metadata';
import { container, type DependencyContainer } from 'tsyringe';
import { resolveRuntimePaths } from '../project-paths.js';
import { createAppLogger, type AppLogger } from '../logging.js';
import { loadServerConfig, type ServerConfig } from '../config.js';
import { TOKENS } from './tokens.js';

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
 * 创建注册了环境、配置、日志器和运行路径的应用 child container。
 *
 * 默认容器只作为父容器和元数据入口；服务实现自 Step 16.2 起在返回的
 * child 内以 `Lifecycle.ContainerScoped` 注册，业务模块不得直接访问
 * 默认容器或在此之外的任何容器。
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
  const paths = resolveRuntimePaths(environment, options.projectRoot);
  const child = container.createChildContainer();
  child.register(TOKENS.processEnv, { useValue: environment });
  child.register(TOKENS.serverConfig, { useValue: config });
  child.register(TOKENS.appLogger, { useValue: logger });
  child.register(TOKENS.runtimePaths, { useValue: paths });
  child.register(TOKENS.clock, { useValue: Date.now });
  return child;
}
