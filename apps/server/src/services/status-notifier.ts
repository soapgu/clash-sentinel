import {
  streamNotificationSchema,
  type StreamNotification,
  type StreamNotificationReason,
  type StreamResource,
} from '@clash-sentinel/shared';

/** 接收单条已校验 SSE 失效通知。 */
export type StatusNotificationListener = (
  notification: StreamNotification,
) => void;

/** 业务服务发布状态变化所需的最小接口。 */
export interface StatusNotifier {
  publish(reason: StreamNotificationReason, resources: StreamResource[]): void;
}

interface Subscriber {
  listener: StatusNotificationListener;
  onClose: () => void;
}

/** 当前进程内的 SSE 通知广播中心，不保存或重放历史事件。 */
export class StatusNotificationCenter implements StatusNotifier {
  private readonly subscribers = new Set<Subscriber>();
  private nextId = 1;
  private closed = false;
  private readonly now: () => Date;

  /** @param now 测试可注入的当前时间。 */
  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  /** 发布通知；单个订阅者失败时将其隔离并关闭。 */
  publish(reason: StreamNotificationReason, resources: StreamResource[]): void {
    if (this.closed) return;
    const notification = this.createNotification(reason, resources);
    for (const subscriber of [...this.subscribers])
      this.deliver(subscriber, notification);
  }

  /**
   * 注册订阅者并只向该订阅者发送一次全量同步通知。
   *
   * @returns 幂等退订函数。
   */
  subscribe(
    listener: StatusNotificationListener,
    onClose: () => void = () => undefined,
  ): () => void {
    if (this.closed) {
      this.closeSubscriber({ listener, onClose });
      return () => undefined;
    }
    const subscriber = { listener, onClose };
    this.subscribers.add(subscriber);
    this.deliver(
      subscriber,
      this.createNotification('sync', [
        'monitoring',
        'status',
        'sites',
        'candidates',
        'events',
        'settings',
      ]),
    );
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.subscribers.delete(subscriber);
    };
  }

  /** 关闭全部订阅者；关闭后发布和订阅均无副作用。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const subscriber of [...this.subscribers])
      this.closeSubscriber(subscriber);
  }

  /** 仅供运行状态和测试确认订阅已释放。 */
  getSubscriberCount(): number {
    return this.subscribers.size;
  }

  private createNotification(
    reason: StreamNotificationReason,
    resources: StreamResource[],
  ): StreamNotification {
    return streamNotificationSchema.parse({
      version: 1,
      id: this.nextId++,
      occurredAt: this.now().toISOString(),
      reason,
      resources,
    });
  }

  private deliver(
    subscriber: Subscriber,
    notification: StreamNotification,
  ): void {
    try {
      subscriber.listener(notification);
    } catch {
      this.closeSubscriber(subscriber);
    }
  }

  private closeSubscriber(subscriber: Subscriber): void {
    this.subscribers.delete(subscriber);
    try {
      subscriber.onClose();
    } catch {
      // 单个客户端的关闭错误不能影响其他订阅者或后台业务。
    }
  }
}
