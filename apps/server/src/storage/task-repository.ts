import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  storedTaskSchema,
  taskRecoveryStatusSchema,
  taskTypeSchema,
  type StoredJsonObject,
  type StoredTask,
  type TaskRecoveryStatus,
  type TaskType,
} from '@clash-sentinel/shared';
import { StorageError } from './errors.js';
import { decodeJson, encodeJson, sanitizeText } from './json-codec.js';
import { fromEpoch } from './value-codec.js';

type Row = Record<string, unknown>;

/** 读写持久化任务及其状态转换。 */
export class TaskRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly redactSensitiveData: boolean,
  ) {}

  /**
   * 创建一个处于 queued 状态的持久化任务。
   *
   * @param type 固定任务类型。
   * @param input 可选任务输入，写入前会脱敏并限制大小。
   * @returns 新任务记录。
   */
  createTask(
    type: TaskType,
    input: StoredJsonObject | null = null,
  ): StoredTask {
    const validType = taskTypeSchema.parse(type);
    const id = randomUUID();
    this.database
      .prepare(
        `
        INSERT INTO tasks (id, type, status, created_at, input_json)
        VALUES (?, ?, 'queued', ?, ?)
      `,
      )
      .run(id, validType, Date.now(), this.encodeJson(input));
    return this.getTask(id)!;
  }

  /**
   * 将 queued 任务转换为 running。
   *
   * @param id 任务 UUID。
   * @returns 更新后的任务。
   */
  startTask(id: string): StoredTask {
    this.transitionTask(
      id,
      "UPDATE tasks SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'",
      [Date.now(), id],
    );
    return this.getTask(id)!;
  }

  /**
   * 将 running 任务标记为成功并保存脱敏结果。
   *
   * @param id 任务 UUID。
   * @param result 可选任务结果。
   * @returns 更新后的任务。
   */
  completeTask(id: string, result: StoredJsonObject | null = null): StoredTask {
    this.transitionTask(
      id,
      "UPDATE tasks SET status = 'succeeded', finished_at = ?, result_json = ? WHERE id = ? AND status = 'running'",
      [Date.now(), this.encodeJson(result), id],
    );
    return this.getTask(id)!;
  }

  /**
   * 将 queued 或 running 任务标记为失败。
   *
   * @param id 任务 UUID。
   * @param errorCode 稳定错误码。
   * @param errorMessage 不包含敏感数据的错误说明。
   * @returns 更新后的任务。
   */
  failTask(
    id: string,
    errorCode: string,
    errorMessage: string,
    recoveryStatus: TaskRecoveryStatus | null = null,
  ): StoredTask {
    const validRecoveryStatus =
      recoveryStatus === null
        ? null
        : taskRecoveryStatusSchema.parse(recoveryStatus);
    this.transitionTask(
      id,
      "UPDATE tasks SET status = 'failed', finished_at = ?, error_code = ?, error_message = ?, recovery_status = ? WHERE id = ? AND status IN ('queued', 'running')",
      [
        Date.now(),
        errorCode.slice(0, 100),
        this.sanitizeText(errorMessage).slice(0, 2_000),
        validRecoveryStatus,
        id,
      ],
    );
    return this.getTask(id)!;
  }

  /**
   * 读取指定任务。
   *
   * @param id 任务 UUID。
   * @returns 任务记录，不存在时返回 null。
   */
  getTask(id: string): StoredTask | null {
    const row = this.database
      .prepare('SELECT * FROM tasks WHERE id = ?')
      .get(id) as Row | undefined;
    return row ? this.mapTask(row) : null;
  }

  /**
   * 按创建时间倒序读取任务。
   *
   * @param limit 返回数量，最大 200。
   * @param offset 跳过的任务数量。
   * @returns 持久化任务列表。
   */
  listTasks(limit = 100, offset = 0): StoredTask[] {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 200);
    const safeOffset = Math.max(Math.trunc(offset), 0);
    return (
      this.database
        .prepare(
          'SELECT * FROM tasks ORDER BY created_at DESC LIMIT ? OFFSET ?',
        )
        .all(safeLimit, safeOffset) as Row[]
    ).map((row) => this.mapTask(row));
  }

  /** 读取指定类型的 queued/running 任务 ID。 */
  listActiveTaskIds(type: TaskType): string[] {
    const validType = taskTypeSchema.parse(type);
    return (
      this.database
        .prepare(
          "SELECT id FROM tasks WHERE type = ? AND status IN ('queued', 'running') ORDER BY created_at, id",
        )
        .all(validType) as Array<{ id: string }>
    ).map((row) => row.id);
  }

  /**
   * 将服务重启前遗留的 queued/running 任务安全终止为 interrupted。
   *
   * @returns 被恢复处理的任务数量。
   */
  recoverInterruptedTasks(): number {
    const result = this.database
      .prepare(
        `
        UPDATE tasks SET status = 'interrupted', finished_at = ?,
          error_code = 'SERVICE_RESTARTED', error_message = '服务重启中断，任务未自动重放',
          recovery_status = CASE
            WHEN type IN ('apply', 'reset', 'rollback', 'auto_switch') THEN 'unknown'
            ELSE NULL
          END
        WHERE status IN ('queued', 'running')
      `,
      )
      .run(Date.now());
    return result.changes;
  }

  /** 将任务查询行转换为共享领域对象。 */
  private mapTask(row: Row): StoredTask {
    return storedTaskSchema.parse({
      id: row.id,
      type: row.type,
      status: row.status,
      createdAt: fromEpoch(Number(row.created_at)),
      startedAt:
        row.started_at === null ? null : fromEpoch(Number(row.started_at)),
      finishedAt:
        row.finished_at === null ? null : fromEpoch(Number(row.finished_at)),
      input: decodeJson(row.input_json),
      result: decodeJson(row.result_json),
      errorCode: row.error_code,
      errorMessage: row.error_message,
      recoveryStatus: row.recovery_status ?? null,
    });
  }

  /** 对要求特定前置状态的任务更新执行统一结果检查。 */
  private transitionTask(id: string, sql: string, parameters: unknown[]) {
    const result = this.database.prepare(sql).run(...parameters);
    if (result.changes > 0) return;
    if (!this.getTask(id)) throw new StorageError('NOT_FOUND', '任务不存在');
    throw new StorageError('INVALID_TRANSITION', '任务当前状态不允许此操作');
  }

  private sanitizeText(value: string) {
    return sanitizeText(value, this.redactSensitiveData);
  }

  private encodeJson(value: StoredJsonObject | null | undefined) {
    return encodeJson(value, this.redactSensitiveData);
  }
}
