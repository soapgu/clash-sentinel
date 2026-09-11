import type { QueryClient } from '@tanstack/react-query';
import {
  streamNotificationSchema,
  type StreamBaseResource,
} from '@clash-sentinel/shared';
import {
  allDashboardQueryKeys,
  snapshotQueryKeys,
  streamQueryKeys,
} from './queries.js';

export type StreamState = 'connecting' | 'connected' | 'offline';

interface EventSourceLike {
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  close(): void;
}

export interface DashboardStreamOptions {
  createEventSource?: (url: string) => EventSourceLike;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  queueMicrotaskFn?: typeof queueMicrotask;
  document?: Pick<
    Document,
    'visibilityState' | 'addEventListener' | 'removeEventListener'
  >;
  reconnectDelaysMs?: readonly number[];
  fallbackIntervalMs?: number;
}

/** 管理 SSE、精确 Query 失效、断线轮询和页面可见性生命周期。 */
export class DashboardStream {
  private source: EventSourceLike | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private fallbackTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempt = 0;
  private stopped = true;
  private state: StreamState = 'connecting';
  private pendingResources = new Set<string>();
  private flushQueued = false;
  private readonly listeners = new Set<(state: StreamState) => void>();
  private readonly createEventSource: (url: string) => EventSourceLike;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private readonly queueMicrotaskFn: typeof queueMicrotask;
  private readonly documentRef?: DashboardStreamOptions['document'];
  private readonly reconnectDelaysMs: readonly number[];
  private readonly fallbackIntervalMs: number;

  constructor(
    private readonly client: Pick<QueryClient, 'invalidateQueries'>,
    options: DashboardStreamOptions = {},
  ) {
    this.createEventSource =
      options.createEventSource ?? ((url) => new EventSource(url));
    this.setTimeoutFn = (options.setTimeoutFn ?? setTimeout).bind(globalThis);
    this.clearTimeoutFn = (options.clearTimeoutFn ?? clearTimeout).bind(
      globalThis,
    );
    this.setIntervalFn = (options.setIntervalFn ?? setInterval).bind(
      globalThis,
    );
    this.clearIntervalFn = (options.clearIntervalFn ?? clearInterval).bind(
      globalThis,
    );
    this.queueMicrotaskFn = (options.queueMicrotaskFn ?? queueMicrotask).bind(
      globalThis,
    );
    this.documentRef = options.document ?? globalThis.document;
    this.reconnectDelaysMs = options.reconnectDelaysMs ?? [
      1_000, 2_000, 5_000, 10_000, 30_000,
    ];
    this.fallbackIntervalMs = options.fallbackIntervalMs ?? 15_000;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.documentRef?.addEventListener(
      'visibilitychange',
      this.handleVisibility,
    );
    this.connect();
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.source?.close();
    this.source = null;
    if (this.reconnectTimer !== null) this.clearTimeoutFn(this.reconnectTimer);
    if (this.fallbackTimer !== null) this.clearIntervalFn(this.fallbackTimer);
    this.reconnectTimer = null;
    this.fallbackTimer = null;
    this.documentRef?.removeEventListener(
      'visibilitychange',
      this.handleVisibility,
    );
  }

  subscribe(listener: (state: StreamState) => void) {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  getState() {
    return this.state;
  }

  private setState(state: StreamState) {
    if (state === this.state) return;
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }

  private connect() {
    if (this.stopped) return;
    this.setState(this.reconnectAttempt === 0 ? 'connecting' : 'offline');
    const source = this.createEventSource('/api/stream');
    this.source = source;
    source.onopen = () => {
      if (this.source === source) this.setState('connected');
    };
    source.addEventListener('invalidate', (event) => {
      if (this.source !== source) return;
      const parsed = streamNotificationSchema.safeParse(
        this.parseEventData(event.data),
      );
      if (!parsed.success) return;
      if (parsed.data.reason === 'sync') {
        this.reconnectAttempt = 0;
        this.stopFallback();
        this.setState('connected');
        this.queueResources(
          Object.keys(streamQueryKeys) as StreamBaseResource[],
        );
        return;
      }
      this.queueResources(parsed.data.resources);
    });
    source.onerror = () => {
      if (this.source !== source || this.stopped) return;
      source.close();
      this.source = null;
      this.setState('offline');
      this.startFallback();
      this.scheduleReconnect();
    };
  }

  private parseEventData(data: unknown) {
    if (typeof data !== 'string') return undefined;
    try {
      return JSON.parse(data) as unknown;
    } catch {
      return undefined;
    }
  }

  private queueResources(resources: readonly string[]) {
    for (const resource of resources) this.pendingResources.add(resource);
    if (this.flushQueued || this.pendingResources.size === 0) return;
    this.flushQueued = true;
    this.queueMicrotaskFn(() => {
      this.flushQueued = false;
      const pending = [...this.pendingResources];
      this.pendingResources.clear();
      for (const resource of pending) {
        const queryKey = resource.startsWith('task:')
          ? ['task', resource.slice(5)]
          : streamQueryKeys[resource as StreamBaseResource];
        if (queryKey)
          void this.client.invalidateQueries({ queryKey, exact: true });
      }
    });
  }

  private scheduleReconnect() {
    if (this.reconnectTimer !== null || this.stopped) return;
    const index = Math.min(
      this.reconnectAttempt,
      this.reconnectDelaysMs.length - 1,
    );
    const delay = this.reconnectDelaysMs[index]!;
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.setTimeoutFn(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startFallback() {
    if (this.fallbackTimer !== null || this.stopped) return;
    this.fallbackTimer = this.setIntervalFn(() => {
      if (this.documentRef?.visibilityState === 'hidden') return;
      this.invalidateAllDashboardQueries();
    }, this.fallbackIntervalMs);
  }

  private stopFallback() {
    if (this.fallbackTimer === null) return;
    this.clearIntervalFn(this.fallbackTimer);
    this.fallbackTimer = null;
  }

  private invalidateAllDashboardQueries() {
    for (const queryKey of allDashboardQueryKeys)
      void this.client.invalidateQueries({ queryKey, exact: true });
  }

  private readonly handleVisibility = () => {
    if (this.documentRef?.visibilityState !== 'visible') return;
    for (const queryKey of snapshotQueryKeys)
      void this.client.invalidateQueries({ queryKey, exact: true });
  };
}
