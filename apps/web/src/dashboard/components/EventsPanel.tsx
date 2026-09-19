import type { EventRecord } from '@clash-sentinel/shared';
import { formatDateTime } from '../formatters.js';

export function EventsPanel({ events }: { events: EventRecord[] | undefined }) {
  return (
    <section className="panel events-panel" aria-labelledby="events-title">
      <div className="section-heading">
        <div>
          <span className="eyebrow">操作与状态变化</span>
          <h2 id="events-title">最近事件</h2>
        </div>
        <span className="event-count">{events?.length ?? 0} 条</span>
      </div>
      {!events?.length ? (
        <div className="empty-state">
          <strong>尚无事件</strong>
          <span>状态变化和任务结果将记录在这里。</span>
        </div>
      ) : (
        <ol className="event-list">
          {events.slice(0, 8).map((event) => (
            <li key={event.id} className={`severity-${event.severity}`}>
              <i aria-hidden="true" />
              <div>
                <strong>{event.summary}</strong>
                <span>{formatDateTime(event.occurredAt)}</span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
