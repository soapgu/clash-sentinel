import type Database from 'better-sqlite3';

/** 单个按版本顺序执行的数据库迁移。 */
export interface Migration {
  /** 单调递增且不可复用的迁移版本。 */
  version: number;
  /** 便于诊断迁移历史的稳定名称。 */
  name: string;
  /** 在迁移事务内创建或调整数据库结构。 */
  up: (database: Database.Database) => void;
}

/** 初始化 Clash Sentinel 本地存储结构的首个迁移。 */
const initialSchema: Migration = {
  version: 1,
  name: 'initial_schema',
  up(database) {
    database.exec(`
      CREATE TABLE settings (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        check_interval_ms INTEGER NOT NULL CHECK (check_interval_ms BETWEEN 1000 AND 86400000),
        request_timeout_ms INTEGER NOT NULL CHECK (request_timeout_ms BETWEEN 100 AND 60000),
        entry_failure_threshold INTEGER NOT NULL CHECK (entry_failure_threshold BETWEEN 1 AND 100),
        auto_switch_cooldown_ms INTEGER NOT NULL CHECK (auto_switch_cooldown_ms BETWEEN 0 AND 86400000),
        monitoring_enabled INTEGER NOT NULL CHECK (monitoring_enabled IN (0, 1)),
        auto_switch_enabled INTEGER NOT NULL CHECK (auto_switch_enabled IN (0, 1)),
        auto_switch_profile_uid TEXT,
        updated_at INTEGER NOT NULL,
        CHECK (auto_switch_enabled = 0 OR auto_switch_profile_uid IS NOT NULL)
      );

      CREATE TABLE health_snapshot (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        status TEXT NOT NULL CHECK (status IN ('healthy', 'internet_uncertain', 'internet_down', 'entry_suspected', 'entry_down', 'proxy_error', 'unknown')),
        profile_uid TEXT,
        profile_name TEXT,
        locked INTEGER NOT NULL CHECK (locked IN (0, 1)),
        entry_domain TEXT,
        current_ip TEXT,
        internet_success INTEGER CHECK (internet_success >= 0),
        internet_total INTEGER CHECK (internet_total > 0),
        consecutive_failures INTEGER NOT NULL CHECK (consecutive_failures >= 0),
        recommended_ip TEXT,
        auto_switch_cooldown_until INTEGER,
        updated_at INTEGER NOT NULL,
        CHECK ((profile_uid IS NULL AND profile_name IS NULL) OR profile_uid IS NOT NULL),
        CHECK ((locked = 0 AND entry_domain IS NULL AND current_ip IS NULL) OR (locked = 1 AND entry_domain IS NOT NULL AND current_ip IS NOT NULL)),
        CHECK ((internet_success IS NULL AND internet_total IS NULL) OR (internet_success IS NOT NULL AND internet_total IS NOT NULL AND internet_success <= internet_total))
      );

      CREATE TABLE site_snapshots (
        target TEXT PRIMARY KEY CHECK (target IN ('baidu', 'taobao', 'tencent', 'google', 'github', 'openai_status')),
        reachable INTEGER NOT NULL CHECK (reachable IN (0, 1)),
        http_status INTEGER CHECK (http_status BETWEEN 100 AND 599),
        duration_ms REAL CHECK (duration_ms >= 0),
        error_type TEXT CHECK (error_type IN ('dns', 'timeout', 'connection', 'tls', 'http', 'proxy', 'parse', 'unknown')),
        checked_at INTEGER NOT NULL,
        service_status TEXT CHECK (service_status IN ('operational', 'degraded', 'partial_outage', 'major_outage', 'maintenance', 'unknown')),
        incident_summary TEXT,
        CHECK ((reachable = 1 AND error_type IS NULL) OR reachable = 0),
        CHECK (reachable = 1 OR (http_status IS NULL AND duration_ms IS NULL)),
        CHECK (target = 'openai_status' OR (service_status IS NULL AND incident_summary IS NULL))
      );

      CREATE TABLE site_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target TEXT NOT NULL CHECK (target IN ('baidu', 'taobao', 'tencent', 'google', 'github', 'openai_status')),
        reachable INTEGER NOT NULL CHECK (reachable IN (0, 1)),
        http_status INTEGER CHECK (http_status BETWEEN 100 AND 599),
        duration_ms REAL CHECK (duration_ms >= 0),
        error_type TEXT CHECK (error_type IN ('dns', 'timeout', 'connection', 'tls', 'http', 'proxy', 'parse', 'unknown')),
        checked_at INTEGER NOT NULL,
        service_status TEXT CHECK (service_status IN ('operational', 'degraded', 'partial_outage', 'major_outage', 'maintenance', 'unknown')),
        incident_summary TEXT,
        CHECK ((reachable = 1 AND error_type IS NULL) OR reachable = 0),
        CHECK (reachable = 1 OR (http_status IS NULL AND duration_ms IS NULL)),
        CHECK (target = 'openai_status' OR (service_status IS NULL AND incident_summary IS NULL))
      );
      CREATE INDEX site_history_target_checked_idx ON site_history(target, checked_at DESC, id DESC);

      CREATE TABLE diagnosis_snapshot (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('testable', 'skipped')),
        generated_at INTEGER NOT NULL,
        saved_at INTEGER NOT NULL,
        profile_uid TEXT NOT NULL,
        profile_name TEXT NOT NULL,
        domain TEXT,
        skip_reason TEXT,
        detail TEXT,
        tested_ports_json TEXT NOT NULL,
        test_rounds INTEGER NOT NULL CHECK (test_rounds > 0),
        recommended_ip TEXT
      );

      CREATE TABLE diagnosis_candidates (
        diagnosis_id TEXT NOT NULL REFERENCES diagnosis_snapshot(id) ON DELETE CASCADE,
        ip TEXT NOT NULL,
        eligible INTEGER NOT NULL CHECK (eligible IN (0, 1)),
        success INTEGER NOT NULL CHECK (success >= 0),
        total INTEGER NOT NULL CHECK (total > 0),
        success_rate REAL NOT NULL CHECK (success_rate BETWEEN 0 AND 100),
        average_ms REAL NOT NULL CHECK (average_ms >= 0),
        failed_ports_json TEXT NOT NULL,
        sources_json TEXT NOT NULL,
        PRIMARY KEY (diagnosis_id, ip)
      );

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('health_check', 'diagnose', 'apply', 'reset', 'rollback', 'auto_switch')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'interrupted')),
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        input_json TEXT,
        result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        CHECK ((status IN ('queued', 'running') AND finished_at IS NULL) OR (status IN ('succeeded', 'failed', 'interrupted') AND finished_at IS NOT NULL))
      );
      CREATE INDEX tasks_created_idx ON tasks(created_at DESC);

      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error', 'critical')),
        retention TEXT NOT NULL CHECK (retention IN ('ordinary', 'critical')),
        summary TEXT NOT NULL,
        details_json TEXT,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        profile_uid TEXT,
        occurred_at INTEGER NOT NULL
      );
      CREATE INDEX events_retention_time_idx ON events(retention, occurred_at DESC, id DESC);
    `);
  },
};

/** 按版本升序排列的全部数据库迁移。 */
const taskRecoveryStatus: Migration = {
  version: 2,
  name: 'task_recovery_status',
  up(database) {
    database.exec(`
      ALTER TABLE tasks ADD COLUMN recovery_status TEXT
        CHECK (recovery_status IN ('not_required', 'recovered', 'recovery_failed', 'unknown'));
    `);
  },
};

const healthStatusDetail: Migration = {
  version: 3,
  name: 'health_status_detail',
  up(database) {
    database.exec(`ALTER TABLE health_snapshot ADD COLUMN status_detail TEXT
      CHECK (status_detail IN ('controller_auth_failed'));`);
  },
};

export const migrations: readonly Migration[] = [
  initialSchema,
  taskRecoveryStatus,
  healthStatusDetail,
];

/**
 * 在独立事务中应用所有尚未执行的迁移。
 *
 * @param database 已打开的 SQLite 连接。
 * @param availableMigrations 可用迁移列表；测试可注入故障迁移验证回滚。
 */
export function runMigrations(
  database: Database.Database,
  availableMigrations: readonly Migration[] = migrations,
) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);
  const applied = new Set(
    database
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((row) => (row as { version: number }).version),
  );
  for (const migration of availableMigrations) {
    if (applied.has(migration.version)) continue;
    database.transaction(() => {
      migration.up(database);
      database
        .prepare(
          'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
        )
        .run(migration.version, migration.name, Date.now());
    })();
  }
}
