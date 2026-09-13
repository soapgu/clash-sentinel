import type Database from 'better-sqlite3';
import {
  eventRecordSchema,
  type EventRecord,
  type EventRetention,
  type EventSeverity,
  type StoredJsonObject,
} from '@clash-sentinel/shared';
import { decodeJson, encodeJson, sanitizeText } from './json-codec.js';
import { fromEpoch, toEpoch } from './value-codec.js';

type Row = Record<string, unknown>;

/** 普通事件保留数量。 */
export const ORDINARY_EVENT_LIMIT = 1_000;
/** 关键事件保留数量。 */
export const CRITICAL_EVENT_LIMIT = 200;

/** 创建持久化事件时由数据库生成字段之外的输入。 */
export interface CreateEventInput {
  type: string;
  severity: EventSeverity;
  retention: EventRetention;
  summary: string;
  details?: StoredJsonObject | null;
  taskId?: string | null;
  profileUid?: string | null;
  occurredAt?: string;
}

/** 读写审计事件。 */
export class EventRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly redactSensitiveData: boolean,
  ) {}

  /**
   * 追加事件并按其保留分类清理旧记录。
   *
   * @param event 数据库生成 ID 之外的事件内容。
   * @returns 新保存的事件。
   */
  appendEvent(event: CreateEventInput): EventRecord {
    const occurredAt = event.occurredAt ?? new Date().toISOString();
    const candidate = {
      id: 1,
      type: event.type,
      severity: event.severity,
      retention: event.retention,
      summary: this.sanitizeText(event.summary),
      details: event.details ?? null,
      taskId: event.taskId ?? null,
      profileUid: event.profileUid ?? null,
      occurredAt,
    };
    eventRecordSchema.parse(candidate);
    return this.database.transaction(() => {
      const info = this.database
        .prepare(
          `
          INSERT INTO events (
            type, severity, retention, summary, details_json, task_id, profile_uid, occurred_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          candidate.type,
          candidate.severity,
          candidate.retention,
          candidate.summary,
          this.encodeJson(candidate.details),
          candidate.taskId,
          candidate.profileUid,
          toEpoch(candidate.occurredAt),
        );
      this.pruneEvents(candidate.retention);
      return this.getEvent(Number(info.lastInsertRowid))!;
    })();
  }

  /**
   * 按时间倒序读取事件。
   *
   * @param limit 返回数量，最大 200。
   * @param offset 跳过的事件数量。
   * @returns 事件记录列表。
   */
  listEvents(limit = 100, offset = 0): EventRecord[] {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 200);
    const safeOffset = Math.max(Math.trunc(offset), 0);
    return (
      this.database
        .prepare(
          'SELECT * FROM events ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?',
        )
        .all(safeLimit, safeOffset) as Row[]
    ).map((row) => this.mapEvent(row));
  }

  /**
   * 读取全部事件数量，用于 API 的 limit/offset 分页元数据。
   *
   * @returns 当前事件总数。
   */
  countEvents(): number {
    const row = this.database
      .prepare('SELECT COUNT(*) AS count FROM events')
      .get() as { count: number };
    return row.count;
  }

  /** 对两类事件执行显式数量清理。 */
  pruneHistory() {
    this.database.transaction(() => {
      this.pruneEvents('ordinary');
      this.pruneEvents('critical');
    })();
  }

  /** 读取单个事件查询行。 */
  private getEvent(id: number): EventRecord | null {
    const row = this.database
      .prepare('SELECT * FROM events WHERE id = ?')
      .get(id) as Row | undefined;
    return row ? this.mapEvent(row) : null;
  }

  /** 将事件查询行转换为共享领域对象。 */
  private mapEvent(row: Row): EventRecord {
    return eventRecordSchema.parse({
      id: row.id,
      type: row.type,
      severity: row.severity,
      retention: row.retention,
      summary: row.summary,
      details: decodeJson(row.details_json),
      taskId: row.task_id,
      profileUid: row.profile_uid,
      occurredAt: fromEpoch(Number(row.occurred_at)),
    });
  }

  /** 删除指定分类保留数量之外的旧事件。 */
  private pruneEvents(retention: EventRetention) {
    const limit =
      retention === 'ordinary' ? ORDINARY_EVENT_LIMIT : CRITICAL_EVENT_LIMIT;
    this.database
      .prepare(
        `
        DELETE FROM events WHERE retention = ? AND id NOT IN (
          SELECT id FROM events WHERE retention = ?
          ORDER BY occurred_at DESC, id DESC LIMIT ?
        )
      `,
      )
      .run(retention, retention, limit);
  }

  private sanitizeText(value: string) {
    return sanitizeText(value, this.redactSensitiveData);
  }

  private encodeJson(value: StoredJsonObject | null | undefined) {
    return encodeJson(value, this.redactSensitiveData);
  }
}
