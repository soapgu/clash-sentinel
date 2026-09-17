import { describe, expect, it } from 'vitest';
import {
  inject,
  injectable,
  Lifecycle,
  type DependencyContainer,
} from 'tsyringe';
import { createAppContainer } from './container.js';
import { TOKENS } from './tokens.js';
import { noopLogger, type AppLogger } from '../logging.js';
import type { ServerConfig } from '../config.js';
import type { RuntimePaths } from '../project-paths.js';

/** 构造只依赖值 token 的测试容器，避免读取真实配置和输出日志。 */
function createTestContainer(
  logger: AppLogger = noopLogger,
): DependencyContainer {
  return createAppContainer({
    environment: {},
    config: {
      logging: { redactSensitiveData: true },
      storage: { redactSensitiveData: true },
    } satisfies ServerConfig,
    logger,
  });
}

@injectable()
class ClockConsumer {
  constructor(@inject(TOKENS.clock) readonly clock: () => number) {}
}

@injectable()
class ServiceAggregator {
  constructor(
    @inject(TOKENS.appLogger) readonly logger: AppLogger,
    @inject(TOKENS.processEnv) readonly environment: NodeJS.ProcessEnv,
  ) {}
}

@injectable()
class ScopedFixture {
  constructor(@inject(TOKENS.appLogger) readonly logger: AppLogger) {}
}

@injectable()
class ScopedConsumer {
  constructor(@inject(ScopedFixture) readonly fixture: ScopedFixture) {}
}

describe('createAppContainer', () => {
  it('在不依赖 emitDecoratorMetadata 的情况下通过显式 token 完成构造注入', () => {
    const child = createTestContainer();
    const consumer = child.resolve(ClockConsumer);
    expect(consumer.clock).toBe(Date.now);

    const aggregator = child.resolve(ServiceAggregator);
    expect(aggregator.logger).toBe(noopLogger);
    expect(aggregator.environment).toEqual({});
  });

  it('值 token 解析为注册的环境、配置、日志器、路径和时钟', () => {
    const child = createTestContainer();
    expect(child.resolve(TOKENS.appLogger)).toBe(noopLogger);
    expect(child.resolve(TOKENS.processEnv)).toEqual({});
    expect(child.resolve(TOKENS.serverConfig)).toEqual({
      logging: { redactSensitiveData: true },
      storage: { redactSensitiveData: true },
    });
    expect(child.resolve(TOKENS.clock)).toBe(Date.now);
    const paths = child.resolve<RuntimePaths>(TOKENS.runtimePaths);
    expect(paths.projectRoot).toBeTypeOf('string');
    expect(paths.databasePath).toBeTypeOf('string');
  });

  it('ContainerScoped 对象在同一 child 内保持相同实例', () => {
    const child = createTestContainer();
    child.register(
      ScopedFixture,
      { useClass: ScopedFixture },
      { lifecycle: Lifecycle.ContainerScoped },
    );
    child.register(
      ScopedConsumer,
      { useClass: ScopedConsumer },
      { lifecycle: Lifecycle.ContainerScoped },
    );
    const first = child.resolve(ScopedConsumer);
    const second = child.resolve(ScopedConsumer);
    expect(second).toBe(first);
    expect(second.fixture).toBe(first.fixture);
  });

  it('两个 child container 的 ContainerScoped 对象互不共享', () => {
    const childA = createTestContainer();
    const childB = createTestContainer();
    for (const child of [childA, childB]) {
      child.register(
        ScopedFixture,
        { useClass: ScopedFixture },
        { lifecycle: Lifecycle.ContainerScoped },
      );
    }
    expect(childA.resolve(ScopedFixture)).not.toBe(
      childB.resolve(ScopedFixture),
    );
  });

  it('一个 child 中的依赖覆盖不会泄漏到其他 child', () => {
    const childA = createTestContainer();
    const childB = createTestContainer();
    const replacementLogger: AppLogger = noopLogger;
    childB.register(TOKENS.appLogger, { useValue: replacementLogger });
    childA.register(
      ScopedFixture,
      { useClass: ScopedFixture },
      { lifecycle: Lifecycle.ContainerScoped },
    );
    childB.register(
      ScopedFixture,
      { useClass: ScopedFixture },
      { lifecycle: Lifecycle.ContainerScoped },
    );

    expect(childB.resolve(TOKENS.appLogger)).toBe(replacementLogger);
    expect(childA.resolve(TOKENS.appLogger)).toBe(noopLogger);
    expect(childA.resolve(ScopedFixture).logger).toBe(noopLogger);
  });
});
