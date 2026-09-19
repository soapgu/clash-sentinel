import type { SiteResult, SiteTarget } from '@clash-sentinel/shared';
import baiduLogo from '../../../../docs/design/high-fidelity/assets/baidu-official.png';
import githubLogo from '../../../../docs/design/high-fidelity/assets/github.svg';
import googleLogo from '../../../../docs/design/high-fidelity/assets/google.svg';
import openaiLogo from '../../../../docs/design/high-fidelity/assets/openai.svg';
import taobaoLogo from '../../../../docs/design/high-fidelity/assets/taobao-official.png';
import tencentLogo from '../../../../docs/design/high-fidelity/assets/tencent-official.png';

export const siteMeta: Record<
  SiteTarget,
  { name: string; logo: string; group: 'direct' | 'proxy' }
> = {
  baidu: { name: '百度', logo: baiduLogo, group: 'direct' },
  taobao: { name: '淘宝', logo: taobaoLogo, group: 'direct' },
  tencent: { name: '腾讯', logo: tencentLogo, group: 'direct' },
  google: { name: 'Google', logo: googleLogo, group: 'proxy' },
  github: { name: 'GitHub', logo: githubLogo, group: 'proxy' },
  openai_status: { name: 'OpenAI', logo: openaiLogo, group: 'proxy' },
};

export const directTargets = ['baidu', 'taobao', 'tencent'] as const;
export const proxyTargets = ['google', 'github', 'openai_status'] as const;

export const serviceLabels: Record<
  NonNullable<SiteResult['serviceStatus']>,
  string
> = {
  operational: '官方服务正常',
  degraded: '官方服务降级',
  partial_outage: '官方服务部分中断',
  major_outage: '官方服务大面积中断',
  maintenance: '官方服务维护中',
  unknown: '官方状态未知',
};
