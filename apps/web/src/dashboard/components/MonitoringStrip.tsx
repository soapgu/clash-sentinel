import type { MonitoringSnapshot, Settings } from '@clash-sentinel/shared';
import { formatTime } from '../formatters.js';

export function MonitoringStrip({
  monitoring,
  settings,
}: {
  monitoring?: MonitoringSnapshot;
  settings?: Settings;
}) {
  const stateLabel = !monitoring
    ? '尚无调度数据'
    : monitoring.state === 'running'
      ? '正在执行定时检测'
      : monitoring.state === 'disabled'
        ? '定时监测已暂停'
        : '等待下一轮';
  const enabled = monitoring?.enabled ?? settings?.monitoringEnabled;
  return (
    <section className="monitor-strip panel" aria-labelledby="monitor-title">
      <div className="monitor-heading">
        <span className="monitor-icon" aria-hidden="true">
          ◴
        </span>
        <div>
          <span className="eyebrow">自动调度</span>
          <h2 id="monitor-title">定时监测</h2>
        </div>
      </div>
      <div className="monitor-state">
        <span className={`status-pill ${enabled ? 'success' : 'neutral'}`}>
          ● {enabled ? '已开启' : '已暂停'}
        </span>
        <strong>{stateLabel}</strong>
        <small>
          {settings
            ? `每 ${Math.round(settings.checkIntervalMs / 1_000)} 秒检测一次`
            : '正在读取监测策略'}
        </small>
      </div>
      <div className="monitor-time">
        <span>上次检测</span>
        <strong>{formatTime(monitoring?.lastCompletedAt)}</strong>
      </div>
      <div className="monitor-time">
        <span>{monitoring?.state === 'running' ? '本轮开始' : '预计下次'}</span>
        <strong>
          {formatTime(
            monitoring?.state === 'running'
              ? monitoring.lastStartedAt
              : monitoring?.nextRunAt,
          )}
        </strong>
      </div>
    </section>
  );
}
