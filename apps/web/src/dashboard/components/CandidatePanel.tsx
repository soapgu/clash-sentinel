import type { StoredDiagnosis } from '@clash-sentinel/shared';
import { CANDIDATE_FRESHNESS_MS, isDiagnosisFresh } from '../../freshness.js';
import { formatTime } from '../formatters.js';

export function CandidatePanel({
  diagnosis,
  now,
  offline,
  currentIp,
  busy,
  onApply,
}: {
  diagnosis: StoredDiagnosis | null | undefined;
  now: number;
  offline: boolean;
  currentIp: string | null;
  busy: boolean;
  onApply: (ip: string) => void;
}) {
  const fresh = isDiagnosisFresh(diagnosis ?? null, now) && !offline;
  const expiresAt = diagnosis
    ? new Date(
        Date.parse(diagnosis.savedAt) + CANDIDATE_FRESHNESS_MS,
      ).toISOString()
    : null;
  return (
    <section
      className="panel candidates-panel"
      aria-labelledby="candidates-title"
    >
      <div className="section-heading">
        <div>
          <span className="eyebrow">最近诊断</span>
          <h2 id="candidates-title">候选 IP</h2>
        </div>
        <span className={`status-pill ${fresh ? 'success' : 'neutral'}`}>
          {diagnosis
            ? fresh
              ? `有效至 ${formatTime(expiresAt)}`
              : '报告已过期'
            : '尚无报告'}
        </span>
      </div>
      {!diagnosis ? (
        <div className="empty-state">
          <strong>尚无候选数据</strong>
          <span>完成严格诊断后将在这里显示候选。</span>
        </div>
      ) : diagnosis.status === 'skipped' ? (
        <div className="empty-state">
          <strong>当前订阅不支持候选测试</strong>
          <span>
            {diagnosis.detail ?? diagnosis.skipReason ?? '未提供原因'}
          </span>
        </div>
      ) : diagnosis.candidates.length === 0 ? (
        <div className="empty-state">
          <strong>未找到合格候选</strong>
          <span>保持当前配置，等待下一次诊断。</span>
        </div>
      ) : (
        <div className="candidate-list">
          {diagnosis.candidates.map((candidate) => {
            const applicable =
              fresh && candidate.eligible && candidate.ip !== currentIp;
            return (
              <article
                className={`candidate ${candidate.ip === diagnosis.recommendedIp ? 'recommended' : ''}`}
                key={candidate.ip}
              >
                <div>
                  <strong>{candidate.ip}</strong>
                  {candidate.ip === diagnosis.recommendedIp ? (
                    <span className="recommend-label">推荐</span>
                  ) : null}
                  <span>{candidate.sources.join(' · ') || '来源未知'}</span>
                </div>
                <div className="candidate-stats">
                  <span>
                    成功率 <strong>{candidate.successRate}%</strong>
                  </span>
                  <span>
                    平均 <strong>{Math.round(candidate.averageMs)} ms</strong>
                  </span>
                  <span>
                    {candidate.success} / {candidate.total}
                  </span>
                </div>
                <button
                  className="button compact"
                  disabled={!applicable || busy || offline}
                  onClick={() => onApply(candidate.ip)}
                >
                  {candidate.ip === currentIp ? '当前 IP' : '应用'}
                </button>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
