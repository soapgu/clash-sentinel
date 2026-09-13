import { expect, test } from 'vitest';
import type {
  DiagnosisCandidate,
  HealthSnapshot,
  Settings,
} from '@clash-sentinel/shared';
import {
  canAutoSwitch,
  selectAutoSwitchCandidate,
} from './auto-switch-policy.js';

const nowMs = Date.parse('2026-09-11T04:01:00.000Z');

function settings(): Settings {
  return {
    checkIntervalMs: 60_000,
    requestTimeoutMs: 5_000,
    entryFailureThreshold: 3,
    autoSwitchCooldownMs: 300_000,
    monitoringEnabled: true,
    autoSwitchEnabled: true,
    autoSwitchProfileUid: 'profile-main',
    updatedAt: '2026-09-11T04:00:00.000Z',
  };
}

function snapshot(): HealthSnapshot {
  return {
    status: 'entry_down',
    profile: { uid: 'profile-main', name: '主订阅' },
    lock: {
      locked: true,
      domain: 'entry.example.test',
      ip: '198.51.100.20',
    },
    internetSuccess: 2,
    internetTotal: 3,
    consecutiveFailures: 3,
    recommendedIp: null,
    autoSwitchCooldownUntil: null,
    updatedAt: '2026-09-11T04:00:00.000Z',
  };
}

test('全部准入条件满足时允许自动切换', () => {
  expect(canAutoSwitch(settings(), snapshot(), nowMs)).toBe(true);
});

for (const [name, settingsPatch, snapshotPatch] of [
  ['自动切换关闭', { autoSwitchEnabled: false }, {}],
  ['绑定订阅不匹配', { autoSwitchProfileUid: 'profile-other' }, {}],
  ['缺少当前订阅', {}, { profile: null }],
  ['状态不是入口故障', {}, { status: 'entry_suspected' }],
  ['国内网络成功数不足', {}, { internetSuccess: 1 }],
  ['连续失败未达到阈值', {}, { consecutiveFailures: 2 }],
  ['入口未锁定', {}, { lock: { locked: false } }],
] as const) {
  test(`${name}时拒绝自动切换`, () => {
    expect(
      canAutoSwitch(
        { ...settings(), ...settingsPatch },
        { ...snapshot(), ...snapshotPatch } as HealthSnapshot,
        nowMs,
      ),
    ).toBe(false);
  });
}

for (const [offsetMs, expected] of [
  [1, false],
  [0, true],
  [-1, true],
] as const) {
  test(`冷却截止时间相对当前时间 ${offsetMs}ms 时准入结果为 ${expected}`, () => {
    expect(
      canAutoSwitch(
        settings(),
        {
          ...snapshot(),
          autoSwitchCooldownUntil: new Date(nowMs + offsetMs).toISOString(),
        },
        nowMs,
      ),
    ).toBe(expected);
  });
}

function candidate(
  ip: string,
  averageMs: number,
  eligible = true,
): DiagnosisCandidate {
  return {
    ip,
    eligible,
    success: eligible ? 2 : 1,
    total: 2,
    successRate: eligible ? 100 : 50,
    averageMs,
    failedPorts: eligible ? [] : [443],
    sources: ['system'],
  };
}

test('候选选择排除当前和不合格地址并优先最低延迟', () => {
  expect(
    selectAutoSwitchCandidate(
      [
        candidate('198.51.100.20', 1),
        candidate('198.51.100.21', 2, false),
        candidate('198.51.100.22', 20),
        candidate('198.51.100.23', 10),
      ],
      '198.51.100.20',
    )?.ip,
  ).toBe('198.51.100.23');
});

test('候选延迟相同时按 IP 稳定选择且不修改输入顺序', () => {
  const candidates = [
    candidate('198.51.100.23', 10),
    candidate('198.51.100.22', 10),
  ];
  expect(selectAutoSwitchCandidate(candidates, null)?.ip).toBe('198.51.100.22');
  expect(candidates.map((item) => item.ip)).toEqual([
    '198.51.100.23',
    '198.51.100.22',
  ]);
});

test('没有可用候选时返回 undefined', () => {
  expect(
    selectAutoSwitchCandidate(
      [candidate('198.51.100.20', 10), candidate('198.51.100.21', 20, false)],
      '198.51.100.20',
    ),
  ).toBeUndefined();
});
