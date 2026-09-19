import type { SiteSnapshotView, SiteTarget } from '@clash-sentinel/shared';
import { formatTime } from '../formatters.js';
import { serviceLabels, siteMeta } from '../site-meta.js';

export function SiteCard({
  target,
  result,
  offline,
}: {
  target: SiteTarget;
  result: SiteSnapshotView | null | undefined;
  offline: boolean;
}) {
  const meta = siteMeta[target];
  const stale = offline || result?.stale;
  const tone = stale
    ? 'neutral'
    : result?.reachable
      ? 'success'
      : result
        ? 'danger'
        : 'neutral';
  const primary = !result
    ? '尚无检测数据'
    : result.reachable
      ? `HTTP ${result.httpStatus} · ${Math.round(result.durationMs ?? 0)} ms`
      : `连接失败 · ${result.errorType ?? 'unknown'}`;
  return (
    <article
      className={`site-card ${meta.group === 'direct' ? 'mini-site' : ''} ${stale ? 'is-stale' : ''}`}
    >
      <div className="site-identity">
        <img src={meta.logo} alt="" />
        <div>
          <strong>{meta.name}</strong>
          <span className={`site-state ${tone}`}>
            ●{' '}
            {stale
              ? '数据可能过期'
              : result?.reachable
                ? '可达'
                : result
                  ? '不可达'
                  : '未知'}
          </span>
        </div>
      </div>
      <div className="site-metrics">
        <strong>{primary}</strong>
        <span>检测于 {formatTime(result?.checkedAt)}</span>
      </div>
      {target === 'openai_status' && result?.serviceStatus ? (
        <div className="service-status">
          {serviceLabels[result.serviceStatus]}
          {result.incidentSummary ? ` · ${result.incidentSummary}` : ''}
        </div>
      ) : null}
    </article>
  );
}
