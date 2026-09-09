import { expect, test } from 'vitest';
import { parseOpenAiStatus } from './openai-status.js';

test('解析总体状态并只保留第一条活动事故标题', () => {
  expect(
    parseOpenAiStatus(
      JSON.stringify({
        status: { indicator: 'minor' },
        incidents: [
          { name: '响应延迟\n升高', status: 'investigating' },
          { name: '已恢复事故', status: 'resolved' },
        ],
      }),
    ),
  ).toEqual({
    serviceStatus: 'degraded',
    incidentSummary: '响应延迟 升高',
  });
});

test('非法或未知状态安全降级为 unknown', () => {
  expect(parseOpenAiStatus('{bad')).toEqual({
    serviceStatus: 'unknown',
    incidentSummary: null,
  });
  expect(parseOpenAiStatus('{"status":{"indicator":"future"}}')).toEqual({
    serviceStatus: 'unknown',
    incidentSummary: null,
  });
});

test.each([
  ['none', 'operational'],
  ['minor', 'degraded'],
  ['major', 'partial_outage'],
  ['critical', 'major_outage'],
  ['maintenance', 'maintenance'],
] as const)('将 Statuspage 指示器 %s 映射为 %s', (indicator, expected) => {
  expect(
    parseOpenAiStatus(JSON.stringify({ status: { indicator } })).serviceStatus,
  ).toBe(expected);
});
