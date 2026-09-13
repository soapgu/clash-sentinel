import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  diagnosisResultSchema,
  storedDiagnosisSchema,
  type DiagnosisResult,
  type StoredDiagnosis,
} from '@clash-sentinel/shared';
import { fromEpoch, toEpoch } from './value-codec.js';

type Row = Record<string, unknown>;

/** 读写最近诊断及候选集合。 */
export class DiagnosisRepository {
  constructor(private readonly database: Database.Database) {}

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

  /** 清除已失效的最近诊断及其级联候选。 */
  clearDiagnosis(): boolean {
    return (
      this.database
        .prepare('DELETE FROM diagnosis_snapshot WHERE singleton_id = 1')
        .run().changes > 0
    );
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
}
