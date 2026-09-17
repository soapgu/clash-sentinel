import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { expect, test } from 'vitest';

/**
 * 容器实例操作（默认容器、child 创建、resolve）允许出现的全部源码位置。
 * 业务类导入 injectable/inject 装饰器是既定方案，不在约束范围内；
 * 约束的是 Service Locator 形态：取得容器实例并直接调用。
 */
const CONTAINER_OPERATION_ALLOWED = new Set([
  'src/composition/container.ts',
  'src/index.ts',
]);

/** 递归收集目录下全部 TypeScript 源文件。 */
async function collectSourceFiles(
  directory: string,
  collected: string[] = [],
): Promise<string[]> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) await collectSourceFiles(entryPath, collected);
    else if (entry.isFile() && entry.name.endsWith('.ts'))
      collected.push(entryPath);
  }
  return collected;
}

/** 读取组合根之外的全部业务源码（不含测试）。 */
async function readBusinessSources() {
  const srcRoot = fileURLToPath(new URL('../', import.meta.url));
  const serverRoot = fileURLToPath(new URL('../../', import.meta.url));
  const files = await collectSourceFiles(srcRoot);
  const sources: Array<{ path: string; source: string }> = [];
  for (const file of files) {
    const relativePath = relative(serverRoot, file);
    if (relativePath.endsWith('.test.ts')) continue;
    sources.push({ path: relativePath, source: await readFile(file, 'utf8') });
  }
  expect(sources.length).toBeGreaterThan(0);
  return sources;
}

/** 默认容器实例只允许出现在容器工厂。 */
const DEFAULT_CONTAINER_ALLOWED = new Set(['src/composition/container.ts']);

test('业务模块只导入装饰器，不取得容器实例', async () => {
  const sources = await readBusinessSources();
  const violations: string[] = [];

  for (const { path, source } of sources) {
    if (DEFAULT_CONTAINER_ALLOWED.has(path)) continue;
    // 从 tsyringe 导入 container（默认容器实例）即视为 Service Locator 入口。
    const containerImport = source.match(
      /import\s+\{([^}]*)\}\s+from\s+['"]tsyringe['"]/,
    );
    const imported = containerImport?.[1]
      ?.split(',')
      .map((name) => name.trim().split(/\s+as\s+/)[0])
      .filter(Boolean);
    if (imported?.includes('container'))
      violations.push(`${path}: 导入了默认容器实例`);
  }

  expect(violations).toEqual([]);
});

test('容器操作只出现在组合根和入口', async () => {
  const sources = await readBusinessSources();
  const violations: string[] = [];

  for (const { path, source } of sources) {
    if (CONTAINER_OPERATION_ALLOWED.has(path)) continue;

    if (/\.createChildContainer\s*\(/.test(source))
      violations.push(`${path}: 创建了 child container`);
    if (/(?:container|child|c)\.resolve\s*\(/.test(source))
      violations.push(`${path}: 调用了容器 resolve`);
    if (/\bDependencyContainer\b/.test(source))
      violations.push(`${path}: 引用了容器类型并可能持有实例`);
  }

  expect(violations).toEqual([]);
});

test('组合根与入口保持唯一：白名单文件确实执行容器操作', async () => {
  const srcRoot = fileURLToPath(new URL('../', import.meta.url));
  const serverRoot = fileURLToPath(new URL('../../', import.meta.url));
  const composerPath = join(srcRoot, 'composition/container.ts');
  const entryPath = join(srcRoot, 'index.ts');

  const composer = await readFile(composerPath, 'utf8');
  const entry = await readFile(entryPath, 'utf8');

  // 容器工厂持有默认容器并创建 child；入口唯一一次 resolve 应用根。
  expect(composer).toMatch(/createChildContainer\s*\(/);
  expect(entry).toMatch(/resolve\s*\(\s*ApplicationRuntime\s*\)/);
  // 白名单之外不再有其他位置组合容器。
  expect(relative(serverRoot, composerPath)).toBe(
    'src/composition/container.ts',
  );
});
