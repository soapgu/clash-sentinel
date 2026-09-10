import { expect, test } from 'vitest';
import type { StoredDiagnosis } from '@clash-sentinel/shared';
import { CANDIDATE_FRESHNESS_MS, isDiagnosisFresh } from './freshness.js';

const diagnosis = { savedAt: '2026-09-10T00:00:00.000Z' } as StoredDiagnosis;

test('候选报告在三十分钟边界前有效，边界起过期', () => {
  const savedAt = Date.parse(diagnosis.savedAt);
  expect(
    isDiagnosisFresh(diagnosis, savedAt + CANDIDATE_FRESHNESS_MS - 1),
  ).toBe(true);
  expect(isDiagnosisFresh(diagnosis, savedAt + CANDIDATE_FRESHNESS_MS)).toBe(
    false,
  );
  expect(isDiagnosisFresh(null, savedAt)).toBe(false);
});
