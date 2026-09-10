import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import {
  diagnosisResultSchema,
  eventRecordSchema,
  healthSnapshotSchema,
  settingsDefaults,
  settingsSchema,
  siteResultSchema,
  siteTargetSchema,
  storedDiagnosisSchema,
  storedTaskSchema,
  taskTypeSchema,
  type DiagnosisResult,
  type EventRecord,
  type EventRetention,
  type EventSeverity,
  type HealthSnapshot,
  type Settings,
  type SiteResult,
  type SiteTarget,
  type StoredDiagnosis,
  type StoredJsonObject,
  type StoredTask,
  type TaskType,
} from '@clash-sentinel/shared';
import { DEFAULT_PROJECT_ROOT } from '../project-paths.js';
import { runMigrations } from './migrations.js';

/** 每个站点保留的历史结果数量。 */
export const SITE_HISTORY_LIMIT = 1_000;
/** 普通事件保留数量。 */
export const ORDINARY_EVENT_LIMIT = 1_000;
/** 关键事件保留数量。 */
export const CRITICAL_EVENT_LIMIT = 200;
/** 单个任务或事件 JSON 字段允许保存的最大字节数。 */
export const STORED_JSON_LIMIT = 32 * 1024;

/** SQLite 存储初始化选项。 */
export interface SqliteStoreOptions {
  /** 数据库路径；相对路径基于项目根目录解析。 */
  databasePath?: string;
  /** 默认数据库路径使用的项目根目录；测试或嵌入场景可覆盖。 */
  projectRoot?: string;
}

/** 解析稳定且不依赖进程 cwd 的 SQLite 文件路径。 */
export function resolveDatabasePath(
  options: SqliteStoreOptions = {},
  environment: NodeJS.ProcessEnv = process.env,
) {
  const configured =
    options.databasePath ??
    environment.CLASH_SENTINEL_DB_PATH ??
    '.state/clash-sentinel.db';
  if (configured === ':memory:') return configured;
  return resolve(options.projectRoot ?? DEFAULT_PROJECT_ROOT, configured);
}

/** 创建持久化事件时由数据库生成字段之外的输入。 */
export interface CreateEventInput {
  /** 稳定事件类型。 */
  type: string;
  /** 事件严重级别。 */
  severity: EventSeverity;
  /** 历史清理使用的保留分类。 */
  retention: EventRetention;
  /** 面向用户的简短事件说明。 */
  summary: string;
  /** 可选的脱敏结构化详情。 */
  details?: StoredJsonObject | null;
  /** 可选关联任务 UUID。 */
  taskId?: string | null;
  /** 可选关联订阅 UID。 */
  profileUid?: string | null;
  /** 事件时间；省略时使用当前时间。 */
  occurredAt?: string;
}

/** 本地存储验证、状态转换或序列化失败。 */
export class StorageError extends Error {
  /**
   * 创建可由上层稳定处理的存储错误。
   *
   * @param code 存储错误分类。
   * @param message 不包含敏感数据的错误说明。
   */
  constructor(
    public readonly code:
      'VALIDATION' | 'NOT_FOUND' | 'INVALID_TRANSITION' | 'SERIALIZATION',
    message: string,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

/** SQLite 查询结果的通用字段映射。 */
type Row = Record<string, unknown>;

/** 需要从任意扩展 JSON 中移除的敏感字段名。 */
const SENSITIVE_KEY =
  /(?:secret|password|token|authorization|authHeader|mihomo|config(?:uration)?|subscription(?:Content)?|raw(?:Content|Config)?)/i;
/** 普通字符串中可能出现的本机绝对路径。 */
const LOCAL_PATH = /\/(?:Users|private|tmp|var|Volumes)(?:\/[^,;\n]*)+/g;
/** 判断整个字符串是否为需要脱敏的本机绝对路径。 */
const ABSOLUTE_LOCAL_PATH = /^\/(?:Users|private|tmp|var|Volumes)\//;

/**
 * 将 Unix 毫秒转换为领域对象使用的 ISO 8601 时间。
 *
 * @param value Unix 毫秒。
 * @returns ISO 8601 时间文本。
 */
function fromEpoch(value: number) {
  return new Date(value).toISOString();
}

/**
 * 将领域对象中的时间转换为 Unix 毫秒。
 *
 * @param value ISO 8601 或 Legacy 可解析时间文本。
 * @returns Unix 毫秒。
 * @throws {StorageError} 时间无法解析时抛出。
 */
function toEpoch(value: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed))
    throw new StorageError('VALIDATION', '时间字段格式无效');
  return parsed;
}

/**
 * 递归移除结构化扩展数据中的敏感字段、完整订阅和本机路径。
 *
 * @param value 待清理的未知值。
 * @param seen 用于拒绝循环引用的对象集合。
 * @returns 可安全 JSON 序列化的值。
 */
function sanitizeJson(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number')
    return value;
  if (typeof value === 'string') {
    if (/^\s*proxies\s*:/m.test(value) || /^\s*proxy-groups\s*:/m.test(value))
      return '[订阅内容已脱敏]';
    if (ABSOLUTE_LOCAL_PATH.test(value)) return '[路径已脱敏]';
    return value.replace(LOCAL_PATH, '[路径已脱敏]');
  }
  if (typeof value !== 'object')
    throw new StorageError('SERIALIZATION', '扩展数据包含不可序列化值');
  if (seen.has(value))
    throw new StorageError('SERIALIZATION', '扩展数据不能包含循环引用');
  seen.add(value);
  if (Array.isArray(value))
    return value.map((item) => sanitizeJson(item, seen));
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value))
    output[key] = SENSITIVE_KEY.test(key)
      ? '[敏感字段已脱敏]'
      : sanitizeJson(item, seen);
  return output;
}

/**
 * 将扩展对象脱敏并限制大小后编码为 JSON。
 *
 * @param value 可选结构化数据。
 * @returns 可写入 SQLite 的 JSON 文本或 null。
 */
function encodeJson(value: StoredJsonObject | null | undefined) {
  if (value === null || value === undefined) return null;
  const encoded = JSON.stringify(sanitizeJson(value));
  if (Buffer.byteLength(encoded, 'utf8') > STORED_JSON_LIMIT)
    throw new StorageError('SERIALIZATION', '扩展数据超过 32 KiB 上限');
  return encoded;
}

/**
 * 将 SQLite 中的扩展 JSON 解码并重新校验为对象。
 *
 * @param value 数据库文本或 null。
 * @returns 结构化对象或 null。
 */
function decodeJson(value: unknown): StoredJsonObject | null {
  if (value === null) return null;
  try {
    return JSON.parse(String(value)) as StoredJsonObject;
  } catch {
    throw new StorageError('SERIALIZATION', '数据库中的扩展 JSON 已损坏');
  }
}

/** 提供同步、事务化且可关闭的 Clash Sentinel SQLite 数据访问门面。 */
export class SqliteStore {
  private readonly database: Database.Database;

  /**
   * 打开数据库、配置连接、执行迁移并写入缺失的默认策略。
   *
   * @param options 可选数据库路径配置。
   */
  constructor(options: SqliteStoreOptions = {}) {
    const path = resolveDatabasePath(options);
    if (path !== ':memory:')
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new Database(path);
    this.database.pragma('foreign_keys = ON');
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('busy_timeout = 5000');
    this.database.pragma('synchronous = NORMAL');
    runMigrations(this.database);
    this.ensureDefaultSettings();
    this.recoverInterruptedTasks();
  }

  /** 关闭数据库连接并释放文件句柄。 */
  close() {
    this.database.close();
  }

  /**
   * 读取当前用户策略。
   *
   * @returns 始终存在且通过共享 Schema 校验的策略。
   */
  getSettings(): Settings {
    const row = this.database
      .prepare('SELECT * FROM settings WHERE singleton_id = 1')
      .get() as Row;
    return settingsSchema.parse({
      checkIntervalMs: row.check_interval_ms,
      requestTimeoutMs: row.request_timeout_ms,
      entryFailureThreshold: row.entry_failure_threshold,
      autoSwitchCooldownMs: row.auto_switch_cooldown_ms,
      monitoringEnabled: Boolean(row.monitoring_enabled),
      autoSwitchEnabled: Boolean(row.auto_switch_enabled),
      autoSwitchProfileUid: row.auto_switch_profile_uid,
      updatedAt: fromEpoch(Number(row.updated_at)),
    });
  }

  /**
   * 合并并保存部分策略更新。
   *
   * @param patch 需要修改的策略字段。
   * @returns 更新后的完整策略。
   */
  updateSettings(patch: Partial<Omit<Settings, 'updatedAt'>>): Settings {
    const value = settingsSchema.parse({
      ...this.getSettings(),
      ...patch,
      updatedAt: new Date().toISOString(),
    });
    this.database
      .prepare(
        `
        UPDATE settings SET
          check_interval_ms = ?, request_timeout_ms = ?, entry_failure_threshold = ?,
          auto_switch_cooldown_ms = ?, monitoring_enabled = ?, auto_switch_enabled = ?,
          auto_switch_profile_uid = ?, updated_at = ?
        WHERE singleton_id = 1
      `,
      )
      .run(
        value.checkIntervalMs,
        value.requestTimeoutMs,
        value.entryFailureThreshold,
        value.autoSwitchCooldownMs,
        Number(value.monitoringEnabled),
        Number(value.autoSwitchEnabled),
        value.autoSwitchProfileUid,
        toEpoch(value.updatedAt),
      );
    return this.getSettings();
  }

  /**
   * 读取当前健康快照。
   *
   * @returns 已保存的快照，尚无检测结果时返回 null。
   */
  getHealthSnapshot(): HealthSnapshot | null {
    const row = this.database
      .prepare('SELECT * FROM health_snapshot WHERE singleton_id = 1')
      .get() as Row | undefined;
    if (!row) return null;
    return healthSnapshotSchema.parse({
      status: row.status,
      profile: row.profile_uid
        ? { uid: row.profile_uid, name: row.profile_name ?? '' }
        : null,
      lock: row.locked
        ? { locked: true, domain: row.entry_domain, ip: row.current_ip }
        : { locked: false },
      internetSuccess: row.internet_success,
      internetTotal: row.internet_total,
      consecutiveFailures: row.consecutive_failures,
      recommendedIp: row.recommended_ip,
      autoSwitchCooldownUntil:
        row.auto_switch_cooldown_until === null
          ? null
          : fromEpoch(Number(row.auto_switch_cooldown_until)),
      updatedAt: fromEpoch(Number(row.updated_at)),
    });
  }

  /**
   * 插入或替换当前健康快照。
   *
   * @param snapshot 完整健康快照。
   * @returns 持久化后重新读取的快照。
   */
  upsertHealthSnapshot(snapshot: HealthSnapshot): HealthSnapshot {
    const value = healthSnapshotSchema.parse(snapshot);
    this.database
      .prepare(
        `
        INSERT INTO health_snapshot (
          singleton_id, status, profile_uid, profile_name, locked, entry_domain, current_ip,
          internet_success, internet_total, consecutive_failures, recommended_ip,
          auto_switch_cooldown_until, updated_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(singleton_id) DO UPDATE SET
          status = excluded.status, profile_uid = excluded.profile_uid,
          profile_name = excluded.profile_name, locked = excluded.locked,
          entry_domain = excluded.entry_domain, current_ip = excluded.current_ip,
          internet_success = excluded.internet_success, internet_total = excluded.internet_total,
          consecutive_failures = excluded.consecutive_failures,
          recommended_ip = excluded.recommended_ip,
          auto_switch_cooldown_until = excluded.auto_switch_cooldown_until,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        value.status,
        value.profile?.uid ?? null,
        value.profile?.name ?? null,
        Number(value.lock.locked),
        value.lock.locked ? value.lock.domain : null,
        value.lock.locked ? value.lock.ip : null,
        value.internetSuccess,
        value.internetTotal,
        value.consecutiveFailures,
        value.recommendedIp,
        value.autoSwitchCooldownUntil
          ? toEpoch(value.autoSwitchCooldownUntil)
          : null,
        toEpoch(value.updatedAt),
      );
    return this.getHealthSnapshot()!;
  }

  /**
   * 读取指定站点的当前快照。
   *
   * @param target 固定站点标识。
   * @returns 最近结果，尚无记录时返回 null。
   */
  getSiteSnapshot(target: SiteTarget): SiteResult | null {
    const validTarget = siteTargetSchema.parse(target);
    const row = this.database
      .prepare('SELECT * FROM site_snapshots WHERE target = ?')
      .get(validTarget) as Row | undefined;
    return row ? this.mapSite(row) : null;
  }

  /**
   * 只更新指定站点的当前快照，不追加历史。
   *
   * @param result 站点探测结果。
   * @returns 持久化后的站点快照。
   */
  upsertSiteSnapshot(result: SiteResult): SiteResult {
    const value = siteResultSchema.parse(result);
    this.writeSiteSnapshot(value);
    return this.getSiteSnapshot(value.target)!;
  }

  /**
   * 在同一事务中更新站点快照、追加历史并执行数量清理。
   *
   * @param result 站点探测结果。
   * @returns 新增历史记录 ID。
   */
  appendSiteResult(result: SiteResult): number {
    const value = siteResultSchema.parse(result);
    return this.database.transaction(() => {
      this.writeSiteSnapshot(value);
      const info = this.database
        .prepare(
          `
          INSERT INTO site_history (
            target, reachable, http_status, duration_ms, error_type, checked_at,
            service_status, incident_summary
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(...this.siteParameters(value));
      this.pruneSite(value.target);
      return Number(info.lastInsertRowid);
    })();
  }

  /**
   * 按时间倒序读取指定站点历史。
   *
   * @param target 固定站点标识。
   * @param limit 返回数量，最大 200。
   * @param offset 跳过的历史数量。
   * @returns 站点历史结果列表。
   */
  listSiteHistory(target: SiteTarget, limit = 100, offset = 0): SiteResult[] {
    const validTarget = siteTargetSchema.parse(target);
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 200);
    const safeOffset = Math.max(Math.trunc(offset), 0);
    return (
      this.database
        .prepare(
          'SELECT * FROM site_history WHERE target = ? ORDER BY checked_at DESC, id DESC LIMIT ? OFFSET ?',
        )
        .all(validTarget, safeLimit, safeOffset) as Row[]
    ).map((row) => this.mapSite(row));
  }

  /**
   * 读取最近一次诊断及候选结果。
   *
   * @returns 最近诊断，尚无记录时返回 null。
   */
  getDiagnosis(): StoredDiagnosis | null {
    const row = this.database
      .prepare('SELECT * FROM diagnosis_snapshot WHERE singleton_id = 1')
      .get() as Row | undefined;
    if (!row) return null;
    const candidates = this.database
      .prepare(
        'SELECT * FROM diagnosis_candidates WHERE diagnosis_id = ? ORDER BY eligible DESC, average_ms ASC',
      )
      .all(row.id) as Row[];
    return storedDiagnosisSchema.parse({
      id: row.id,
      status: row.status,
      generatedAt: fromEpoch(Number(row.generated_at)),
      savedAt: fromEpoch(Number(row.saved_at)),
      profile: { uid: row.profile_uid, name: row.profile_name },
      domain: row.domain,
      skipReason: row.skip_reason,
      detail: row.detail,
      testedPorts: JSON.parse(String(row.tested_ports_json)),
      testRounds: row.test_rounds,
      recommendedIp: row.recommended_ip,
      candidates: candidates.map((candidate) => ({
        ip: candidate.ip,
        eligible: Boolean(candidate.eligible),
        success: candidate.success,
        total: candidate.total,
        successRate: candidate.success_rate,
        averageMs: candidate.average_ms,
        failedPorts: JSON.parse(String(candidate.failed_ports_json)),
        sources: JSON.parse(String(candidate.sources_json)),
      })),
    });
  }

  /**
   * 在单一事务中替换最近诊断及全部候选。
   *
   * @param diagnosis Step 3 适配层产生的脱敏诊断结果。
   * @returns 新保存的诊断快照。
   */
  replaceDiagnosis(diagnosis: DiagnosisResult): StoredDiagnosis {
    const value = diagnosisResultSchema.parse(diagnosis);
    const id = randomUUID();
    const savedAt = Date.now();
    this.database.transaction(() => {
      this.database
        .prepare('DELETE FROM diagnosis_snapshot WHERE singleton_id = 1')
        .run();
      this.database
        .prepare(
          `
          INSERT INTO diagnosis_snapshot (
            singleton_id, id, status, generated_at, saved_at, profile_uid, profile_name,
            domain, skip_reason, detail, tested_ports_json, test_rounds, recommended_ip
          ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          id,
          value.status,
          toEpoch(value.generatedAt),
          savedAt,
          value.profile.uid,
          value.profile.name,
          value.domain,
          value.skipReason,
          value.detail,
          JSON.stringify(value.testedPorts),
          value.testRounds,
          value.recommendedIp,
        );
      const insertCandidate = this.database.prepare(`
        INSERT INTO diagnosis_candidates (
          diagnosis_id, ip, eligible, success, total, success_rate, average_ms,
          failed_ports_json, sources_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const candidate of value.candidates)
        insertCandidate.run(
          id,
          candidate.ip,
          Number(candidate.eligible),
          candidate.success,
          candidate.total,
          candidate.successRate,
          candidate.averageMs,
          JSON.stringify(candidate.failedPorts),
          JSON.stringify(candidate.sources),
        );
    })();
    return this.getDiagnosis()!;
  }

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
      .run(id, validType, Date.now(), encodeJson(input));
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
      [Date.now(), encodeJson(result), id],
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
  failTask(id: string, errorCode: string, errorMessage: string): StoredTask {
    this.transitionTask(
      id,
      "UPDATE tasks SET status = 'failed', finished_at = ?, error_code = ?, error_message = ? WHERE id = ? AND status IN ('queued', 'running')",
      [
        Date.now(),
        errorCode.slice(0, 100),
        this.sanitizeText(errorMessage).slice(0, 2_000),
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

  /**
   * 将服务重启前遗留的 running 任务安全终止为 interrupted。
   *
   * @returns 被恢复处理的任务数量。
   */
  recoverInterruptedTasks(): number {
    const result = this.database
      .prepare(
        `
        UPDATE tasks SET status = 'interrupted', finished_at = ?,
          error_code = 'SERVICE_RESTARTED', error_message = '服务重启中断，任务未自动重放'
        WHERE status = 'running'
      `,
      )
      .run(Date.now());
    return result.changes;
  }

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
          encodeJson(candidate.details),
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

  /** 对站点历史和两类事件执行显式批量数量清理。 */
  pruneHistory() {
    this.database.transaction(() => {
      for (const target of siteTargetSchema.options) this.pruneSite(target);
      this.pruneEvents('ordinary');
      this.pruneEvents('critical');
    })();
  }

  /** 在首次迁移后插入缺失的单例默认策略。 */
  private ensureDefaultSettings() {
    this.database
      .prepare(
        `
        INSERT OR IGNORE INTO settings (
          singleton_id, check_interval_ms, request_timeout_ms, entry_failure_threshold,
          auto_switch_cooldown_ms, monitoring_enabled, auto_switch_enabled,
          auto_switch_profile_uid, updated_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        settingsDefaults.checkIntervalMs,
        settingsDefaults.requestTimeoutMs,
        settingsDefaults.entryFailureThreshold,
        settingsDefaults.autoSwitchCooldownMs,
        Number(settingsDefaults.monitoringEnabled),
        Number(settingsDefaults.autoSwitchEnabled),
        settingsDefaults.autoSwitchProfileUid,
        Date.now(),
      );
  }

  /** 将站点结果写入单例快照表。 */
  private writeSiteSnapshot(value: SiteResult) {
    this.database
      .prepare(
        `
        INSERT INTO site_snapshots (
          target, reachable, http_status, duration_ms, error_type, checked_at,
          service_status, incident_summary
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(target) DO UPDATE SET
          reachable = excluded.reachable, http_status = excluded.http_status,
          duration_ms = excluded.duration_ms, error_type = excluded.error_type,
          checked_at = excluded.checked_at, service_status = excluded.service_status,
          incident_summary = excluded.incident_summary
      `,
      )
      .run(...this.siteParameters(value));
  }

  /** 将站点领域对象转换为 SQL 参数数组。 */
  private siteParameters(value: SiteResult) {
    return [
      value.target,
      Number(value.reachable),
      value.httpStatus,
      value.durationMs,
      value.errorType,
      toEpoch(value.checkedAt),
      value.serviceStatus,
      value.incidentSummary,
    ] as const;
  }

  /** 将站点查询行转换为共享领域对象。 */
  private mapSite(row: Row): SiteResult {
    return siteResultSchema.parse({
      target: row.target,
      reachable: Boolean(row.reachable),
      httpStatus: row.http_status,
      durationMs: row.duration_ms,
      errorType: row.error_type,
      checkedAt: fromEpoch(Number(row.checked_at)),
      serviceStatus: row.service_status,
      incidentSummary: row.incident_summary,
    });
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
    });
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

  /** 对要求特定前置状态的任务更新执行统一结果检查。 */
  private transitionTask(id: string, sql: string, parameters: unknown[]) {
    const result = this.database.prepare(sql).run(...parameters);
    if (result.changes > 0) return;
    if (!this.getTask(id)) throw new StorageError('NOT_FOUND', '任务不存在');
    throw new StorageError('INVALID_TRANSITION', '任务当前状态不允许此操作');
  }

  /** 删除指定站点最近 1000 条之外的旧历史。 */
  private pruneSite(target: SiteTarget) {
    this.database
      .prepare(
        `
        DELETE FROM site_history WHERE target = ? AND id NOT IN (
          SELECT id FROM site_history WHERE target = ?
          ORDER BY checked_at DESC, id DESC LIMIT ?
        )
      `,
      )
      .run(target, target, SITE_HISTORY_LIMIT);
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

  /** 清除面向用户文本中的本机路径和完整订阅片段。 */
  private sanitizeText(value: string) {
    const sanitized = sanitizeJson(value);
    return typeof sanitized === 'string' ? sanitized : '[内容已脱敏]';
  }
}
