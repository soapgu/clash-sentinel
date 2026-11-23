import type {
  DiagnosisCandidate,
  StoredDiagnosis,
} from '@clash-sentinel/shared';
import { CANDIDATE_FRESHNESS_MS, isDiagnosisFresh } from '../../freshness.js';
import { formatTime } from '../formatters.js';

const publicResolvers = new Set([
  '119.28.28.28',
  '119.29.29.29',
  '223.5.5.5',
  '223.6.6.6',
]);

function CandidateSources({ sources, sourceLabels }: DiagnosisCandidate) {
  if (!sourceLabels) {
    return (
      <span className="candidate-sources">
        {sources.join(' · ') || '来源未知'}
      </span>
    );
  }

  const evidence = [...new Set(sources)].map((source) => {
    const [tag = '', endpoint] = source.split('@');
    const [origin, role, number, , scope] = tag.split(':');
    return { origin, role, number, scope, endpoint };
  });
  const subscriptionEndpoints = new Set(
    evidence
      .filter(
        ({ origin, scope }) => origin === 'subscription' && scope !== 'local',
      )
      .map(({ endpoint }) => endpoint),
  );
  const subscription = new Set<string>();
  const other = new Set<string>();
  let local = false;
  let publicCount = 0;
  let configuredCount = 0;
  let authorityCount = 0;
  for (const { origin, role, number, scope, endpoint } of evidence) {
    if (origin === 'mihomo-dns' || scope === 'local') {
      local = true;
    } else if (origin === 'subscription' || origin === 'runtime') {
      const prefix =
        role === 'proxy-server-nameserver'
          ? '节点 '
          : role === 'fallback'
            ? '备用 '
            : '';
      const label = `${prefix}DNS #${number}`;
      if (origin === 'subscription') subscription.add(label);
      else if (!subscriptionEndpoints.has(endpoint))
        other.add(`运行配置 ${label}`);
    } else if (origin === 'resolver') {
      if (role && publicResolvers.has(role)) publicCount++;
      else configuredCount++;
    } else if (origin === 'authority') {
      authorityCount++;
    } else if (origin === 'system') {
      other.add('系统 DNS');
    } else if (origin === 'cache') {
      other.add('系统主机查询');
    }
  }
  if (publicCount) other.add(`公共 DNS（${publicCount} 个）`);
  if (configuredCount) other.add(`配置 DNS（${configuredCount} 个）`);
  if (authorityCount) other.add(`权威 DNS（${authorityCount} 个）`);

  return (
    <div className="candidate-sources">
      <span>
        订阅来源 ·{' '}
        {subscription.size
          ? `${[...subscription].join('、')} 返回过此 IP`
          : '本轮未获取到此 IP'}
      </span>
      {local && <span>Clash 本地 DNS 返回过此 IP（具体上游未知）</span>}
      {other.size > 0 && <span>其他来源 · {[...other].join('、')}</span>}
      <details>
        <summary>来源详情</summary>
        <p>{sourceLabels}</p>
      </details>
    </div>
  );
}

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
                  <CandidateSources {...candidate} />
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
