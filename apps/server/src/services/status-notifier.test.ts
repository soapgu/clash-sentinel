import { expect, test, vi } from 'vitest';
import { StatusNotificationCenter } from './status-notifier.js';

test('订阅时单播全量同步，后续通知按进程内 ID 广播', () => {
  const center = new StatusNotificationCenter(
    () => new Date('2026-09-09T04:00:00.000Z'),
  );
  const first = vi.fn();
  const second = vi.fn();
  center.subscribe(first);
  center.subscribe(second);
  expect(first.mock.calls[0]?.[0]).toMatchObject({ id: 1, reason: 'sync' });
  expect(second.mock.calls[0]?.[0]).toMatchObject({ id: 2, reason: 'sync' });
  expect(first).toHaveBeenCalledOnce();
  center.publish('monitoring_started', ['monitoring']);
  expect(first.mock.calls[1]?.[0]).toMatchObject({
    id: 3,
    reason: 'monitoring_started',
    resources: ['monitoring'],
  });
  expect(second.mock.calls[1]?.[0]).toMatchObject({ id: 3 });
});

test('失败订阅者被隔离，退订和关闭保持幂等', () => {
  const center = new StatusNotificationCenter();
  const failedClose = vi.fn();
  center.subscribe(() => {
    throw new Error('client failed');
  }, failedClose);
  expect(failedClose).toHaveBeenCalledOnce();
  expect(center.getSubscriberCount()).toBe(0);

  const listener = vi.fn();
  const closed = vi.fn();
  const unsubscribe = center.subscribe(listener, closed);
  expect(center.getSubscriberCount()).toBe(1);
  unsubscribe();
  unsubscribe();
  expect(center.getSubscriberCount()).toBe(0);
  expect(closed).not.toHaveBeenCalled();

  center.subscribe(listener, closed);
  center.close();
  center.close();
  expect(closed).toHaveBeenCalledOnce();
  expect(center.getSubscriberCount()).toBe(0);
  center.publish('monitoring_started', ['monitoring']);
  expect(() => center.subscribe(listener, closed)).not.toThrow();
});
