import { Writable } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { transports } from 'winston';
import {
  createAppLogger,
  formatLocalTimestamp,
  formatLogLine,
} from './logging.js';

function memoryTransport() {
  let output = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += String(chunk);
      callback();
    },
  });
  return {
    transport: new transports.Stream({ stream }),
    read: () => output,
  };
}

describe('服务端自然文本日志', () => {
  test('使用本地时间、固定等级宽度、模块名和稳定元数据格式', () => {
    const date = new Date(2026, 8, 10, 15, 55, 11, 27);
    expect(formatLocalTimestamp(date)).toBe('2026-09-10 15:55:11:027');
    expect(
      formatLogLine(
        'info',
        'task:service',
        'queued',
        {
          taskType: 'health_check',
          taskId: '13e82a4f-0000-4000-8000-000000000000',
          requestId: 'a3746f67-e481-426e-bbd3-53bea343b2d3',
        },
        '2026-09-10 15:55:11:027',
        false,
      ),
    ).toBe(
      '[2026-09-10 15:55:11:027] [INFO] task:service queued | taskType=health_check taskId=13e82a4f-0000-4000-8000-000000000000 requestId=a3746f67-e481-426e-bbd3-53bea343b2d3',
    );
  });

  test('TTY 添加颜色，非 TTY 不包含 ANSI 控制字符', () => {
    const plain = formatLogLine(
      'warn',
      'http:access',
      'request failed',
      {},
      '2026-09-10 15:55:11:027',
      false,
    );
    const colored = formatLogLine(
      'warn',
      'http:access',
      'request failed',
      {},
      '2026-09-10 15:55:11:027',
      true,
    );
    expect(plain).not.toContain('\u001B[');
    expect(colored).toContain('\u001B[33mWARN');
    expect(colored).toContain('\u001B[36mhttp:access');
  });

  test('敏感字段被移除且 URL 不输出凭据、查询参数和片段', () => {
    const output = formatLogLine(
      'debug',
      'legacy:adapter',
      'command completed',
      {
        token: 'dGVzdDp0ZXN0',
        authorization: 'Bearer secret',
        url: 'http://user:pass@172.16.40.49/auth/token?q=secret#part',
      },
      '2026-09-10 15:55:11:027',
      false,
    );
    expect(output).toContain('token=[REDACTED]');
    expect(output).toContain('authorization=[REDACTED]');
    expect(output).toContain('url=http://172.16.40.49/auth/token');
    expect(output).not.toContain('dGVzdDp0ZXN0');
    expect(output).not.toContain('user:pass');
    expect(output).not.toContain('q=secret');
  });

  test('Error 堆栈换行缩进而不进入 key=value', () => {
    const error = new Error('connect ETIMEDOUT');
    error.stack =
      'Error: connect ETIMEDOUT\n    at Socket.<anonymous> (/Users/example/app.ts:10:2)';
    const output = formatLogLine(
      'error',
      'app:bootstrap',
      'unhandled rejection',
      { error },
      '2026-09-10 15:55:21:027',
      false,
    );
    expect(output).toContain('[ERROR] app:bootstrap unhandled rejection');
    expect(output).toContain('\n    Error: connect ETIMEDOUT');
    expect(output).toContain('at Socket.<anonymous> ([PATH])');
    expect(output).not.toContain('/Users/example');
    expect(output).not.toContain('error=');
  });

  test('关闭脱敏时保留敏感字段、完整 URL、本机路径和错误堆栈', () => {
    const error = new Error('token=stack-secret');
    error.stack =
      'Error: token=stack-secret\n    at run (/Users/example/app.ts:1:1)';
    const output = formatLogLine(
      'error',
      'app:bootstrap',
      'unsafe diagnostic',
      {
        token: 'plain-secret',
        url: 'http://user:pass@example.test/path?q=secret#part',
        path: '/Users/example/config.yaml',
        durationMs: 4.6,
        error,
      },
      '2026-09-10 15:55:21:027',
      false,
      false,
    );
    expect(output).toContain('token=plain-secret');
    expect(output).toContain(
      'url="http://user:pass@example.test/path?q=secret#part"',
    );
    expect(output).toContain('path=/Users/example/config.yaml');
    expect(output).toContain('durationMs=5');
    expect(output).toContain('Error: token=stack-secret');
    expect(output).toContain('/Users/example/app.ts:1:1');
  });

  test('开发环境输出 DEBUG，生产环境过滤 DEBUG', async () => {
    const developmentOutput = memoryTransport();
    const development = createAppLogger({
      environment: { NODE_ENV: 'development', NO_COLOR: '1' },
      now: () => new Date(2026, 8, 10, 15, 55, 11, 27),
      transport: developmentOutput.transport,
    });
    development.debug('http:access', 'request completed', { status: 200 });
    await development.close();
    expect(developmentOutput.read()).toContain('DEBUG');

    const productionOutput = memoryTransport();
    const production = createAppLogger({
      environment: { NODE_ENV: 'production', NO_COLOR: '1' },
      transport: productionOutput.transport,
    });
    production.debug('http:access', 'request completed', { status: 200 });
    production.info('app:bootstrap', 'started');
    await production.close();
    expect(productionOutput.read()).not.toContain('request completed');
    expect(productionOutput.read()).toContain('[INFO] app:bootstrap started');
  });

  test('FORCE_COLOR 覆盖非 TTY 和 NO_COLOR，值为 0 时强制关闭', async () => {
    const forcedOutput = memoryTransport();
    const forced = createAppLogger({
      environment: {
        NODE_ENV: 'development',
        NO_COLOR: '1',
        FORCE_COLOR: '1',
      },
      isTTY: false,
      transport: forcedOutput.transport,
    });
    forced.info('app:bootstrap', 'forced colors');
    await forced.close();
    expect(forcedOutput.read()).toContain('\u001B[32mINFO');
    expect(forcedOutput.read()).toContain('\u001B[36mapp:bootstrap');

    const disabledOutput = memoryTransport();
    const disabled = createAppLogger({
      environment: {
        NODE_ENV: 'development',
        FORCE_COLOR: '0',
      },
      isTTY: true,
      transport: disabledOutput.transport,
    });
    disabled.info('app:bootstrap', 'disabled colors');
    await disabled.close();
    expect(disabledOutput.read()).not.toContain('\u001B[');
  });
});
