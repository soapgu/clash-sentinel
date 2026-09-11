import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DashboardStream, type StreamState } from './stream.js';

class FakeEventSource {
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, (event: MessageEvent) => void>();

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(type, listener);
  }

  close() {
    this.closed = true;
  }

  open() {
    this.onopen?.(new Event('open'));
  }

  fail() {
    this.onerror?.(new Event('error'));
  }

  invalidate(value: unknown) {
    this.listeners.get('invalidate')?.({
      data: JSON.stringify(value),
    } as MessageEvent);
  }

  malformed() {
    this.listeners.get('invalidate')?.({ data: '{' } as MessageEvent);
  }
}

class FakeDocument {
  visibilityState: DocumentVisibilityState = 'visible';
  private listener: (() => void) | null = null;
  addEventListener(
    _type: string,
    listener: EventListenerOrEventListenerObject,
  ) {
    this.listener = listener as () => void;
  }
  removeEventListener() {
    this.listener = null;
  }
  show() {
    this.visibilityState = 'visible';
    this.listener?.();
  }
}

function notification(
  id: number,
  resources: string[],
  reason = 'monitoring_completed',
) {
  return {
    version: 1,
    id,
    occurredAt: '2026-09-10T00:00:00.000Z',
    reason,
    resources,
  };
}

describe('DashboardStream', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('同步全量校准，普通通知精确失效并合并重复资源', () => {
    const sources: FakeEventSource[] = [];
    const invalidateQueries = vi.fn(async (filters: unknown) => {
      void filters;
    });
    const microtasks: Array<() => void> = [];
    const stream = new DashboardStream(
      { invalidateQueries },
      {
        createEventSource: () => {
          const source = new FakeEventSource();
          sources.push(source);
          return source;
        },
        queueMicrotaskFn: (callback) => microtasks.push(callback),
      },
    );
    stream.start();
    expect(sources).toHaveLength(1);
    sources[0]!.invalidate(
      notification(
        1,
        ['monitoring', 'status', 'sites', 'candidates', 'events', 'settings'],
        'sync',
      ),
    );
    microtasks.shift()?.();
    expect(invalidateQueries).toHaveBeenCalledTimes(6);

    invalidateQueries.mockClear();
    sources[0]!.invalidate(notification(2, ['status', 'sites']));
    sources[0]!.invalidate(
      notification(3, ['status', 'task:11111111-1111-4111-8111-111111111111']),
    );
    expect(invalidateQueries).not.toHaveBeenCalled();
    microtasks.shift()?.();
    expect(
      invalidateQueries.mock.calls.map(
        ([value]) => (value as { queryKey: string[] }).queryKey,
      ),
    ).toEqual([
      ['status'],
      ['sites'],
      ['task', '11111111-1111-4111-8111-111111111111'],
    ]);

    sources[0]!.malformed();
    expect(microtasks).toHaveLength(0);
    stream.stop();
  });

  test('断线时按指数退避重连并每十五秒低频读取快照', () => {
    const sources: FakeEventSource[] = [];
    const invalidateQueries = vi.fn(async (filters: unknown) => {
      void filters;
    });
    const stream = new DashboardStream(
      { invalidateQueries },
      {
        createEventSource: () => {
          const source = new FakeEventSource();
          sources.push(source);
          return source;
        },
      },
    );
    const states: StreamState[] = [];
    stream.subscribe((state) => states.push(state));
    stream.start();
    sources[0]!.open();
    sources[0]!.fail();
    expect(sources[0]!.closed).toBe(true);
    expect(stream.getState()).toBe('offline');
    vi.advanceTimersByTime(999);
    expect(sources).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sources).toHaveLength(2);
    sources[1]!.fail();
    vi.advanceTimersByTime(1_999);
    expect(sources).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sources).toHaveLength(3);

    invalidateQueries.mockClear();
    vi.advanceTimersByTime(12_000);
    expect(invalidateQueries).toHaveBeenCalledTimes(7);
    expect(states).toContain('connected');
    expect(states).toContain('offline');
    stream.stop();
  });

  test('连续失败完整采用一、二、五、十、三十秒退避且上限保持三十秒', () => {
    const sources: FakeEventSource[] = [];
    const invalidateQueries = vi.fn(async (filters: unknown) => {
      void filters;
    });
    const stream = new DashboardStream(
      { invalidateQueries },
      {
        createEventSource: () => {
          const source = new FakeEventSource();
          sources.push(source);
          return source;
        },
      },
    );
    stream.start();
    const delays = [1_000, 2_000, 5_000, 10_000, 30_000, 30_000];
    for (const [index, delay] of delays.entries()) {
      sources[index]!.fail();
      vi.advanceTimersByTime(delay - 1);
      expect(sources).toHaveLength(index + 1);
      vi.advanceTimersByTime(1);
      expect(sources).toHaveLength(index + 2);
    }
    stream.stop();
  });

  test('隐藏页面跳过兜底轮询，恢复可见立即校准且同步后停止轮询', () => {
    const sources: FakeEventSource[] = [];
    const document = new FakeDocument();
    const invalidateQueries = vi.fn(async (filters: unknown) => {
      void filters;
    });
    const stream = new DashboardStream(
      { invalidateQueries },
      {
        document,
        createEventSource: () => {
          const source = new FakeEventSource();
          sources.push(source);
          return source;
        },
      },
    );
    stream.start();
    sources[0]!.fail();
    document.visibilityState = 'hidden';
    vi.advanceTimersByTime(15_000);
    expect(invalidateQueries).not.toHaveBeenCalled();

    document.show();
    expect(invalidateQueries).toHaveBeenCalledTimes(6);
    invalidateQueries.mockClear();
    const latest = sources.at(-1)!;
    latest.invalidate(
      notification(
        5,
        ['monitoring', 'status', 'sites', 'candidates', 'events', 'settings'],
        'sync',
      ),
    );
    vi.runAllTicks();
    invalidateQueries.mockClear();
    vi.advanceTimersByTime(30_000);
    expect(invalidateQueries).not.toHaveBeenCalled();
    stream.stop();
  });
});
