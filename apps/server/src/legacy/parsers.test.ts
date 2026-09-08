import { describe, expect, test } from 'vitest';
import {
  LegacyParseError,
  parseDiagnosisReport,
  parseMonitorState,
  parseOperationOutput,
  parseStatusOutput,
} from './parsers.js';

describe('Legacy 输出解析', () => {
  test('解析诊断候选并忽略敏感路径字段', () => {
    const result = parseDiagnosisReport(`# generated_epoch\t1
# generated_at\t2026-09-08 10:00:00 +0800
# status\ttestable
# skip_reason\t-
# profile_uid\tmain
# profile_name\t测试订阅
# raw_file\t/private/secret.yaml
# raw_fingerprint\tabc
# domain\tentry.example.test
# tested_ports\t7001,9051
# test_rounds\t5
ip\teligible\tsuccess\ttotal\tsuccess_rate\taverage_ms\tfailed_ports\tsources
198.51.100.20\tyes\t10\t10\t100.0%\t12.300\t-\tsystem,cache
192.0.2.10\tno\t5\t10\t50.0%\t20.000\t7001\tsystem
`);
    expect(result.recommendedIp).toBe('198.51.100.20');
    expect(result.candidates[1]?.failedPorts).toEqual([7001]);
    expect(JSON.stringify(result)).not.toContain('/private');
    expect(JSON.stringify(result)).not.toContain('abc');
  });

  test('解析跳过报告', () => {
    const result = parseDiagnosisReport(`# generated_epoch\t1
# generated_at\t2026-09-08 10:00:00 +0800
# status\tskipped
# skip_reason\tfixed_ip
# profile_uid\tmain
# profile_name\t测试订阅
# raw_file\tmain.yaml
# raw_fingerprint\tabc
# domain\t-
# tested_ports\t-
# test_rounds\t5
# detail\t订阅已经使用固定 IP
`);
    expect(result).toMatchObject({
      status: 'skipped',
      skipReason: 'fixed_ip',
      candidates: [],
      recommendedIp: null,
    });
  });

  test('拒绝缺少关键字段的诊断报告和监控状态', () => {
    expect(() => parseDiagnosisReport('# status\ttestable\n')).toThrow(
      LegacyParseError,
    );
    expect(() => parseMonitorState('status\thealthy\n')).toThrow(
      LegacyParseError,
    );
  });

  test('解析状态和操作结果', () => {
    const status = parseStatusOutput(`当前订阅：测试订阅（main）
原始配置：main.yaml
入口锁定：entry.example.test -> 198.51.100.20
Mihomo控制接口：可用（unix）
最近报告：testable，订阅=测试订阅，域名=entry.example.test，原因=-
后台健康：entry_down，连续失败=3，推荐=192.0.2.10
`);
    expect(status.lock).toEqual({
      locked: true,
      domain: 'entry.example.test',
      ip: '198.51.100.20',
    });
    expect(status.health?.recommendedIp).toBe('192.0.2.10');
    expect(
      parseOperationOutput(
        'reset',
        '当前订阅没有由 clash-entry-ip.sh 创建的入口锁定，无需恢复。',
      ),
    ).toMatchObject({
      status: 'no_change',
    });
  });
});
