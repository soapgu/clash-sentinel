import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { DEFAULT_PROJECT_ROOT } from '../project-paths.js';
import { LegacyAdapter, LegacyAdapterError } from './adapter.js';
import { noopLogger } from '../logging.js';

const legacyScript = resolve(
  DEFAULT_PROJECT_ROOT,
  'scripts/legacy/clash-entry-ip.sh',
);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function executable(path: string, content: string) {
  await writeFile(path, content);
  await chmod(path, 0o700);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sentinel-legacy-'));
  roots.push(root);
  const appDir = join(root, 'app');
  const binDir = join(root, 'bin');
  const stateDir = join(root, 'state');
  const reportDir = join(root, 'reports');
  const backupDir = join(root, 'backups');
  await Promise.all([
    mkdir(join(appDir, 'profiles'), { recursive: true }),
    mkdir(binDir, { recursive: true }),
  ]);
  const runtime = `mixed-port: 7897
external-controller-unix: /tmp/fake-mihomo.sock
dns:
  nameserver:
  - 223.5.5.5
proxies:
- name: 节点一
  server: entry.example.test
  port: 9051
- name: 节点二
  server: entry.example.test
  port: 7001
proxy-groups: []
`;
  const raw = `proxies:
- {name: 官网地址 - https://example.com, server: placeholder.example, port: 80}
- {name: 节点一, server: entry.example.test, port: 9051}
- {name: 节点二, server: entry.example.test, port: 7001}
proxy-groups: []
`;
  await Promise.all([
    writeFile(join(appDir, 'clash-verge.yaml'), runtime),
    writeFile(
      join(appDir, 'config.yaml'),
      'external-controller-unix: /tmp/fake-mihomo.sock\n',
    ),
    writeFile(
      join(appDir, 'profiles.yaml'),
      `current: main
items:
- uid: script-main
  type: script
  file: main.js
- uid: main
  type: remote
  name: 当前测试订阅
  file: main.yaml
  option:
    script: script-main
- uid: script-other
  type: script
  file: other.js
- uid: other
  type: remote
  name: 其他订阅
  file: other.yaml
  option:
    script: script-other
`,
    ),
    writeFile(join(appDir, 'profiles/main.yaml'), raw),
    writeFile(join(appDir, 'profiles/other.yaml'), raw),
    writeFile(
      join(appDir, 'profiles/main.js'),
      'function main(config, profileName) {\n  return config;\n}\n',
    ),
    writeFile(
      join(appDir, 'profiles/other.js'),
      'function main(config, profileName) {\n  return config;\n}\n',
    ),
  ]);
  await executable(
    join(binDir, 'dig'),
    `#!/usr/bin/env bash
case " $* " in
  *" NS "*) printf 'ns.example.test.\\n' ;;
  *) printf '192.0.2.10\\n198.51.100.20\\n' ;;
esac
`,
  );
  await executable(
    join(binDir, 'nc'),
    `#!/usr/bin/env bash
case " $* " in
  *198.51.100.20*) [ "\${CLASH_TEST_ALL_FAIL:-0}" != 1 ] && [ "\${CLASH_TEST_ENTRY_DOWN:-0}" != 1 ] ;;
  *192.0.2.10*) [ "\${CLASH_TEST_ALL_FAIL:-0}" != 1 ] && [ "\${CLASH_TEST_ENTRY_DOWN:-0}" = 1 ] ;;
  *) exit 1 ;;
esac
`,
  );
  await executable(
    join(binDir, 'curl'),
    `#!/usr/bin/env bash
case " $* " in
  *baidu.com*) site=baidu ;;
  *taobao.com*) site=taobao ;;
  *qq.com*) site=qq ;;
  *--write-out*) [ "\${CLASH_TEST_FAIL_SMOKE:-0}" = 1 ] && exit 1; printf '204'; exit 0 ;;
  */version*) [ "\${CLASH_TEST_CONTROLLER_DOWN:-0}" = 1 ] && exit 1; printf '{}'; exit 0 ;;
  *'-X PUT'*/configs*) [ "\${CLASH_TEST_FAIL_RELOAD:-0}" = 1 ] && exit 1; printf '{}'; exit 0 ;;
  */configs*) printf '{}'; exit 0 ;;
  *) printf '{}'; exit 0 ;;
esac
mode=\${CLASH_TEST_CONNECTIVITY_MODE:-all}
case "$mode:$site" in
  all:*) code=204 ;;
  one:baidu) code=204 ;;
  one:*) code=503 ;;
  none:*) exit 1 ;;
esac
printf '%s' "$code"
`,
  );
  await executable(
    join(binDir, 'dscacheutil'),
    '#!/usr/bin/env bash\nexit 0\n',
  );

  const adapter = (environment: NodeJS.ProcessEnv = {}) =>
    new LegacyAdapter({
      scriptPath: legacyScript,
      appDir,
      stateDir,
      reportDir,
      backupDir,
      environment: {
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        CLASH_ENTRY_SAMPLE_PORTS: '2',
        CLASH_ENTRY_TEST_ROUNDS: '2',
        CLASH_ENTRY_MAX_CONCURRENCY: '2',
        CLASH_ENTRY_FAIL_THRESHOLD: '1',
        ...environment,
      },
    });
  return { root, appDir, stateDir, raw, adapter };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error(`预期错误 ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(LegacyAdapterError);
    expect((error as LegacyAdapterError).code).toBe(code);
    return error as LegacyAdapterError;
  }
}

describe('LegacyAdapter', () => {
  test('诊断、应用、状态、健康、重置和回滚形成完整闭环', async () => {
    const setup = await fixture();
    const adapter = setup.adapter();
    const diagnosis = await adapter.diagnose();
    expect(diagnosis).toMatchObject({
      status: 'testable',
      recommendedIp: '198.51.100.20',
    });
    expect(diagnosis.candidates).toHaveLength(2);
    await expect(adapter.readLatestDiagnosis()).resolves.toEqual(diagnosis);

    await expect(adapter.applyIp('198.51.100.20')).resolves.toMatchObject({
      status: 'applied',
    });
    await expect(adapter.applyIp('198.51.100.20')).resolves.toMatchObject({
      status: 'no_change',
    });
    await expect(adapter.getStatus()).resolves.toMatchObject({
      lock: { locked: true, domain: 'entry.example.test', ip: '198.51.100.20' },
      controllerAvailable: true,
    });
    await expect(adapter.healthCheck()).resolves.toMatchObject({
      status: 'healthy',
      currentIp: '198.51.100.20',
    });
    await expect(adapter.resetLock()).resolves.toMatchObject({
      status: 'reset',
    });
    await expect(adapter.rollback()).resolves.toMatchObject({
      status: 'rolled_back',
    });
  });

  test('稳定映射跳过、无候选、过期报告、订阅和应用错误', async () => {
    const setup = await fixture();
    await writeFile(
      join(setup.appDir, 'profiles/main.yaml'),
      'proxies:\n- {name: 固定入口, server: 10.0.0.1, port: 443}\nproxy-groups: []\n',
    );
    await expect(setup.adapter().diagnose()).resolves.toMatchObject({
      status: 'skipped',
      skipReason: 'fixed_ip',
    });

    await writeFile(join(setup.appDir, 'profiles/main.yaml'), setup.raw);
    const noCandidate = await setup
      .adapter({ CLASH_TEST_ALL_FAIL: '1' })
      .diagnose();
    expect(noCandidate.recommendedIp).toBeNull();
    await setup.adapter().diagnose();

    const reportPath = join(setup.stateDir, 'latest-report.tsv');
    const report = await readFile(reportPath, 'utf8');
    await writeFile(
      reportPath,
      report.replace(/^# generated_epoch\t.*$/m, '# generated_epoch\t1'),
    );
    const expired = await expectCode(
      setup.adapter().applyIp('198.51.100.20'),
      'REPORT_EXPIRED',
    );
    expect(expired.recoveryStatus).toBe('not_required');

    await writeFile(reportPath, report);
    await writeFile(
      join(setup.appDir, 'profiles.yaml'),
      (await readFile(join(setup.appDir, 'profiles.yaml'), 'utf8')).replace(
        'current: main',
        'current: other',
      ),
    );
    await expectCode(
      setup.adapter().applyIp('198.51.100.20'),
      'PROFILE_CHANGED',
    );

    await writeFile(
      join(setup.appDir, 'profiles.yaml'),
      (await readFile(join(setup.appDir, 'profiles.yaml'), 'utf8')).replace(
        'current: other',
        'current: main',
      ),
    );
    await writeFile(
      join(setup.appDir, 'profiles/main.yaml'),
      `${setup.raw}# 已更新\n`,
    );
    await expectCode(
      setup.adapter().applyIp('198.51.100.20'),
      'SUBSCRIPTION_UPDATED',
    );

    await writeFile(join(setup.appDir, 'profiles/main.yaml'), setup.raw);
    await setup.adapter().diagnose();
    const failed = await expectCode(
      setup.adapter({ CLASH_TEST_FAIL_RELOAD: '1' }).applyIp('198.51.100.20'),
      'APPLY_FAILED',
    );
    expect(failed.recoveryStatus).toBe('recovery_failed');
    expect(
      await readFile(join(setup.appDir, 'profiles/main.js'), 'utf8'),
    ).not.toContain('pinnedIp');
  });

  test('修改失败且文件和运行配置均恢复时返回 recovered', async () => {
    const setup = await fixture();
    await setup.adapter().diagnose();
    const error = await expectCode(
      setup.adapter({ CLASH_TEST_FAIL_SMOKE: '1' }).applyIp('198.51.100.20'),
      'APPLY_FAILED',
    );
    expect(error.recoveryStatus).toBe('recovered');
    expect(error.message).not.toContain('RECOVERY_STATUS');
  });

  test('健康状态区分断网、不确定和入口故障', async () => {
    const setup = await fixture();
    await setup.adapter().diagnose();
    await setup.adapter().applyIp('198.51.100.20');
    await expect(
      setup.adapter({ CLASH_TEST_CONNECTIVITY_MODE: 'none' }).healthCheck(),
    ).resolves.toMatchObject({ status: 'internet_down' });
    await expect(
      setup.adapter({ CLASH_TEST_CONNECTIVITY_MODE: 'one' }).healthCheck(),
    ).resolves.toMatchObject({ status: 'internet_uncertain' });
    await expect(
      setup.adapter({ CLASH_TEST_ENTRY_DOWN: '1' }).healthCheck(),
    ).resolves.toMatchObject({
      status: 'entry_down',
      recommendedIp: '192.0.2.10',
    });
  });

  test('拒绝参数注入和不合格候选', async () => {
    const setup = await fixture();
    await setup.adapter().diagnose();
    await expectCode(
      setup
        .adapter()
        .applyIp(`198.51.100.20; touch ${join(setup.root, 'owned')}`),
      'INVALID_CANDIDATE',
    );
    await expectCode(setup.adapter().applyIp('--help'), 'INVALID_CANDIDATE');
    await expectCode(
      setup.adapter().applyIp('192.0.2.10'),
      'INVALID_CANDIDATE',
    );
    await expect(readFile(join(setup.root, 'owned'), 'utf8')).rejects.toThrow();
  });

  test('reset 失败保持原文件且无备份时 rollback 返回稳定错误', async () => {
    const setup = await fixture();
    const noBackup = await expectCode(setup.adapter().rollback(), 'NO_BACKUP');
    expect(noBackup.recoveryStatus).toBe('not_required');
    await setup.adapter().diagnose();
    await setup.adapter().applyIp('198.51.100.20');
    const beforeScript = await readFile(
      join(setup.appDir, 'profiles/main.js'),
      'utf8',
    );
    const beforeRuntime = await readFile(
      join(setup.appDir, 'clash-verge.yaml'),
      'utf8',
    );
    const failed = await expectCode(
      setup.adapter({ CLASH_TEST_FAIL_RELOAD: '1' }).resetLock(),
      'RESET_FAILED',
    );
    expect(failed.recoveryStatus).toBe('recovery_failed');
    expect(await readFile(join(setup.appDir, 'profiles/main.js'), 'utf8')).toBe(
      beforeScript,
    );
    expect(await readFile(join(setup.appDir, 'clash-verge.yaml'), 'utf8')).toBe(
      beforeRuntime,
    );
  });

  test('超时终止整个进程组且控制台摘要不包含异常输出', async () => {
    const setup = await fixture();
    const pidFile = join(setup.root, 'child.pid');
    const timeoutScript = join(setup.root, 'timeout.sh');
    await executable(
      timeoutScript,
      '#!/usr/bin/env bash\nsleep 30 &\nprintf "%s" "$!" >"$PID_FILE"\nwait\n',
    );
    const timedAdapter = new LegacyAdapter({
      scriptPath: timeoutScript,
      appDir: setup.appDir,
      stateDir: setup.stateDir,
      reportDir: join(setup.root, 'reports'),
      backupDir: join(setup.root, 'backups'),
      environment: { PID_FILE: pidFile },
      timeouts: { status: 50 },
      terminateGraceMs: 50,
    });
    await expectCode(timedAdapter.getStatus(), 'TIMEOUT');
    const childPid = Number(await readFile(pidFile, 'utf8'));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    expect(() => process.kill(childPid, 0)).toThrow();

    const failureScript = join(setup.root, 'failure.sh');
    await executable(
      failureScript,
      '#!/usr/bin/env bash\nprintf "错误：路径=%s secret=token-value\\n" "$CLASH_APP_DIR" >&2\nexit 7\n',
    );
    const failedAdapter = new LegacyAdapter({
      scriptPath: failureScript,
      appDir: setup.appDir,
      stateDir: setup.stateDir,
      reportDir: join(setup.root, 'reports'),
      backupDir: join(setup.root, 'backups'),
      logger: {
        ...noopLogger,
        error: (_scope, _message, metadata) => logs.push(metadata ?? {}),
      },
    });
    const logs: Record<string, unknown>[] = [];
    await expectCode(failedAdapter.getStatus(), 'PROCESS_EXITED');
    const content = JSON.stringify(logs);
    expect(content).not.toContain(setup.appDir);
    expect(content).not.toContain('token-value');
    expect(logs).toEqual([
      expect.objectContaining({
        command: 'status',
        errorCode: 'PROCESS_EXITED',
        exitCode: 7,
        stderrBytes: expect.any(Number),
      }),
    ]);
  });
});
