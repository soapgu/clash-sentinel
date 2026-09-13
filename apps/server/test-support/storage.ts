import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import type {
  DiagnosisResult,
  HealthSnapshot,
  SiteResult,
} from '@clash-sentinel/shared';
import { SqliteStore } from '../src/storage/store.js';

/** 当前测试创建且需要清理的临时目录。 */
export const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

export async function createStore() {
  const root = await mkdtemp(join(tmpdir(), 'clash-sentinel-storage-'));
  temporaryRoots.push(root);
  const databasePath = join(root, 'clash-sentinel.db');
  return { root, databasePath, store: new SqliteStore({ databasePath }) };
}

export function healthSnapshot(when: string): HealthSnapshot {
  return {
    status: 'entry_suspected',
    profile: { uid: 'profile-main', name: '当前订阅' },
    lock: {
      locked: true,
      domain: 'entry.example.test',
      ip: '198.51.100.20',
    },
    internetSuccess: 3,
    internetTotal: 3,
    consecutiveFailures: 2,
    recommendedIp: '192.0.2.10',
    autoSwitchCooldownUntil: new Date(Date.parse(when) + 300_000).toISOString(),
    updatedAt: when,
  };
}

export function siteResult(
  target: SiteResult['target'],
  checkedAt: string,
): SiteResult {
  return {
    target,
    reachable: true,
    httpStatus: 204,
    durationMs: 42.5,
    errorType: null,
    checkedAt,
    serviceStatus: target === 'openai_status' ? 'operational' : null,
    incidentSummary: null,
  };
}

export function diagnosis(generatedAt: string): DiagnosisResult {
  return {
    status: 'testable',
    generatedAt,
    profile: { uid: 'profile-main', name: '当前订阅' },
    domain: 'entry.example.test',
    skipReason: null,
    detail: null,
    testedPorts: [7001, 9051],
    testRounds: 5,
    candidates: [
      {
        ip: '198.51.100.20',
        eligible: true,
        success: 10,
        total: 10,
        successRate: 100,
        averageMs: 12.5,
        failedPorts: [],
        sources: ['system'],
      },
      {
        ip: '192.0.2.10',
        eligible: false,
        success: 5,
        total: 10,
        successRate: 50,
        averageMs: 20,
        failedPorts: [7001],
        sources: ['authority:ns.example.test'],
      },
    ],
    recommendedIp: '198.51.100.20',
  };
}
