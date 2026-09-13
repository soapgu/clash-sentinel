import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StoredJsonObject } from '@clash-sentinel/shared';
import { describe, expect, test } from 'vitest';
import { StorageError } from './errors.js';
import { decodeJson, encodeJson } from './json-codec.js';
import { SqliteStore } from './store.js';
import { createStore, temporaryRoots } from '../../test-support/storage.js';

describe('JSON 编解码与脱敏', () => {
  test('纯编解码函数保留空值并拒绝损坏 JSON', () => {
    expect(encodeJson(null, true)).toBeNull();
    expect(decodeJson(null)).toBeNull();
    expect(decodeJson(encodeJson({ value: 42 }, true))).toEqual({ value: 42 });
    expect(() => decodeJson('{broken')).toThrow(StorageError);
  });
  test('敏感字段、完整订阅和本机路径不会写入数据库', async () => {
    const setup = await createStore();
    const task = setup.store.tasks.createTask('apply', {
      controllerSecret: 'super-secret',
      authorizationHeader: 'Bearer private-token',
      nested: { apiToken: 'nested-token' },
      path: '/Users/example/Library/Application Support/private.yaml',
      payload: 'proxies:\n- name: secret-node\nproxy-groups: []',
    });
    setup.store.events.appendEvent({
      type: 'safety_test',
      severity: 'warning',
      retention: 'ordinary',
      summary: '文件 /Users/example/private.yaml 处理失败',
      details: { password: 'plain-password' },
    });
    expect(setup.store.tasks.getTask(task.id)?.input).toEqual({
      controllerSecret: '[敏感字段已脱敏]',
      authorizationHeader: '[敏感字段已脱敏]',
      nested: { apiToken: '[敏感字段已脱敏]' },
      path: '[路径已脱敏]',
      payload: '[订阅内容已脱敏]',
    });
    setup.store.close();
    const raw = (await readFile(setup.databasePath)).toString('utf8');
    for (const forbidden of [
      'super-secret',
      'private-token',
      'nested-token',
      'secret-node',
      'plain-password',
      '/Users/example',
    ])
      expect(raw).not.toContain(forbidden);
  });

  test('关闭脱敏后新任务、事件和错误文本保持原值且重开不改写历史', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clash-sentinel-storage-raw-'));
    temporaryRoots.push(root);
    const databasePath = join(root, 'clash-sentinel.db');
    const store = new SqliteStore({
      databasePath,
      redactSensitiveData: false,
    });
    const queued = store.tasks.createTask('apply', {
      controllerSecret: 'super-secret',
      path: '/Users/example/private.yaml',
      payload: 'proxies:\n- name: secret-node',
    });
    const completed = store.tasks.startTask(
      store.tasks.createTask('diagnose').id,
    );
    store.tasks.completeTask(completed.id, { apiToken: 'result-token' });
    const failed = store.tasks.createTask('reset');
    store.tasks.failTask(
      failed.id,
      'RESET_FAILED',
      '读取 /Users/example/private.yaml 时 token=error-secret',
    );
    store.events.appendEvent({
      type: 'raw_storage_test',
      severity: 'warning',
      retention: 'ordinary',
      summary: '文件 /Users/example/private.yaml 处理失败',
      details: { password: 'plain-password' },
    });
    expect(store.tasks.getTask(queued.id)?.input).toEqual({
      controllerSecret: 'super-secret',
      path: '/Users/example/private.yaml',
      payload: 'proxies:\n- name: secret-node',
    });
    expect(store.tasks.getTask(completed.id)?.result).toEqual({
      apiToken: 'result-token',
    });
    expect(store.tasks.getTask(failed.id)?.errorMessage).toContain(
      'error-secret',
    );
    expect(store.events.listEvents()[0]).toMatchObject({
      summary: '文件 /Users/example/private.yaml 处理失败',
      details: { password: 'plain-password' },
    });
    store.close();

    const reopened = new SqliteStore({
      databasePath,
      redactSensitiveData: true,
    });
    expect(reopened.tasks.getTask(queued.id)?.input).toMatchObject({
      controllerSecret: 'super-secret',
      path: '/Users/example/private.yaml',
    });
    expect(reopened.events.listEvents()[0]?.details).toEqual({
      password: 'plain-password',
    });
    reopened.close();
  });

  test('关闭脱敏仍拒绝循环引用、不可序列化值和超限 JSON', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clash-sentinel-storage-raw-'));
    temporaryRoots.push(root);
    const store = new SqliteStore({
      databasePath: join(root, 'clash-sentinel.db'),
      redactSensitiveData: false,
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() =>
      store.tasks.createTask('apply', cyclic as StoredJsonObject),
    ).toThrow(StorageError);
    expect(() =>
      store.tasks.createTask('apply', {
        invalid: BigInt(1),
      } as unknown as StoredJsonObject),
    ).toThrow(StorageError);
    expect(() =>
      store.tasks.createTask('apply', {
        content: 'x'.repeat(33 * 1024),
      }),
    ).toThrow(/32 KiB/);
    store.close();
  });
});
