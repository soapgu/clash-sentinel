import type {
  DiagnosisCandidate,
  HealthSnapshot,
  Settings,
} from '@clash-sentinel/shared';

/** 自动切换准入判断所需的最小设置集合。 */
export type AutoSwitchPolicySettings = Pick<
  Settings,
  'autoSwitchEnabled' | 'autoSwitchProfileUid' | 'entryFailureThreshold'
>;

/** 通过自动切换准入判断后可安全使用的健康快照。 */
export type AutoSwitchEligibleSnapshot = HealthSnapshot & {
  profile: NonNullable<HealthSnapshot['profile']>;
  lock: Extract<HealthSnapshot['lock'], { locked: true }>;
};

/** 判断最新设置和健康快照是否允许规划或执行自动切换。 */
export function canAutoSwitch(
  settings: AutoSwitchPolicySettings,
  snapshot: HealthSnapshot,
  nowMs: number,
): snapshot is AutoSwitchEligibleSnapshot {
  return (
    settings.autoSwitchEnabled &&
    snapshot.profile !== null &&
    settings.autoSwitchProfileUid === snapshot.profile.uid &&
    snapshot.status === 'entry_down' &&
    (snapshot.internetSuccess ?? 0) >= 2 &&
    snapshot.consecutiveFailures >= settings.entryFailureThreshold &&
    (snapshot.autoSwitchCooldownUntil === null ||
      Date.parse(snapshot.autoSwitchCooldownUntil) <= nowMs) &&
    snapshot.lock.locked
  );
}

/** 从合格候选中稳定选择不同于当前入口且平均延迟最低的一项。 */
export function selectAutoSwitchCandidate(
  candidates: DiagnosisCandidate[],
  currentIp: string | null,
): DiagnosisCandidate | undefined {
  return candidates
    .filter((candidate) => candidate.eligible && candidate.ip !== currentIp)
    .sort(
      (left, right) =>
        left.averageMs - right.averageMs || left.ip.localeCompare(right.ip),
    )[0];
}
