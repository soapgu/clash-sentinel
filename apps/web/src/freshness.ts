import type { StoredDiagnosis } from '@clash-sentinel/shared';

export const CANDIDATE_FRESHNESS_MS = 30 * 60 * 1_000;

/** 诊断从入库时间起固定三十分钟有效；边界时刻视为已过期。 */
export function isDiagnosisFresh(
  diagnosis: StoredDiagnosis | null,
  now = Date.now(),
) {
  return (
    diagnosis !== null &&
    now - Date.parse(diagnosis.savedAt) < CANDIDATE_FRESHNESS_MS
  );
}
