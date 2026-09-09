import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { ClashProxyConfig } from './proxy-config.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

/** 写入隔离的虚构 Clash 配置并返回路径。 */
async function config(content: string) {
  const root = await mkdtemp(join(tmpdir(), 'clash-proxy-config-'));
  roots.push(root);
  const path = join(root, 'clash-verge.yaml');
  await writeFile(path, content);
  return path;
}

test('优先读取 mixed-port 并只生成回环代理地址', async () => {
  const path = await config('mixed-port: 7897\nport: 7890\n');
  await expect(new ClashProxyConfig(path).getProxyUrl()).resolves.toBe(
    'http://127.0.0.1:7897',
  );
});

test('缺失、越界和非法配置不猜测默认端口', async () => {
  for (const content of ['mode: rule\n', 'mixed-port: 70000\n', '{bad']) {
    const path = await config(content);
    await expect(new ClashProxyConfig(path).getProxyUrl()).resolves.toBeNull();
  }
});
