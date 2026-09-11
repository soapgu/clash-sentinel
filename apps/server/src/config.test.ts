import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { loadServerConfig, resolveServerConfigPath } from './config.js';

const temporaryRoots: string[] = [];

async function fixture(contents: string, name = 'config/default.yaml') {
  const root = await mkdtemp(join(tmpdir(), 'clash-sentinel-config-'));
  temporaryRoots.push(root);
  const path = join(root, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
  return { root, path };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

const valid = `logging:\n  redactSensitiveData: true\nstorage:\n  redactSensitiveData: false\n`;

describe('服务端启动配置', () => {
  test('读取项目根目录默认配置', async () => {
    const setup = await fixture(valid);
    expect(resolveServerConfigPath({}, setup.root)).toBe(setup.path);
    expect(loadServerConfig({}, setup.root)).toEqual({
      logging: { redactSensitiveData: true },
      storage: { redactSensitiveData: false },
    });
  });

  test('显式相对路径基于项目根目录，绝对路径保持不变', async () => {
    const relative = await fixture(valid, 'config/local.yaml');
    expect(
      loadServerConfig(
        { CLASH_SENTINEL_CONFIG: 'config/local.yaml' },
        relative.root,
      ),
    ).toEqual(
      expect.objectContaining({ logging: { redactSensitiveData: true } }),
    );

    const absolute = await fixture(valid, 'outside.yaml');
    expect(
      resolveServerConfigPath(
        { CLASH_SENTINEL_CONFIG: absolute.path },
        '/unused/root',
      ),
    ).toBe(absolute.path);
    expect(
      loadServerConfig(
        { CLASH_SENTINEL_CONFIG: absolute.path },
        '/unused/root',
      ),
    ).toEqual(
      expect.objectContaining({ storage: { redactSensitiveData: false } }),
    );
  });

  test.each([
    ['非法 YAML', 'logging: [\n'],
    ['字段缺失', 'logging:\n  redactSensitiveData: true\n'],
    ['未知字段', `${valid}unexpected: true\n`],
    [
      '错误类型',
      'logging:\n  redactSensitiveData: yes\nstorage:\n  redactSensitiveData: true\n',
    ],
  ])('%s 时拒绝启动配置', async (_name, contents) => {
    const setup = await fixture(contents);
    expect(() => loadServerConfig({}, setup.root)).toThrow();
  });

  test('配置文件不存在时抛出读取错误', () => {
    expect(() => loadServerConfig({}, '/definitely/missing/project')).toThrow();
  });
});
