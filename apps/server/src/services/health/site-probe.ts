import { performance } from 'node:perf_hooks';
import { Agent, ProxyAgent, fetch, type Dispatcher } from 'undici';
import { injectable } from 'tsyringe';
import type {
  SiteErrorType,
  SiteResult,
  SiteTarget,
} from '@clash-sentinel/shared';
import { parseOpenAiStatus } from './openai-status.js';

/** 单个固定站点的探测请求。 */
export interface SiteProbeRequest {
  /** 固定站点标识。 */
  target: SiteTarget;
  /** 由服务端常量提供的 HTTPS URL。 */
  url: string;
  /** 单次请求超时，单位为毫秒。 */
  timeoutMs: number;
  /** 海外站点使用的本机 Clash 代理；直连站点为 null。 */
  proxyUrl: string | null;
}

/** 可由测试替换的站点探测能力。 */
export interface SiteProbe {
  /** @returns 满足共享 Schema 的单站结果。 */
  probe(request: SiteProbeRequest): Promise<SiteResult>;
}

/** 从 Undici 异常链中提取稳定错误代码。 */
function errorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const value = error as { code?: unknown; cause?: unknown; name?: unknown };
  if (typeof value.code === 'string') return value.code;
  return value.cause === error ? '' : errorCode(value.cause);
}

/**
 * 将网络异常归一化为站点错误分类。
 *
 * @param error Undici 或底层 Socket 异常。
 * @param proxied 请求是否通过本机 Clash 代理。
 * @returns 可持久化的稳定错误分类。
 */
export function classifyProbeError(
  error: unknown,
  proxied: boolean,
): SiteErrorType {
  const code = errorCode(error);
  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? String(error.name)
      : '';
  if (name === 'AbortError' || code.includes('TIMEOUT')) return 'timeout';
  if (proxied && ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH'].includes(code))
    return 'proxy';
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return 'dns';
  if (code.includes('CERT') || code.includes('TLS')) return 'tls';
  if (['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH'].includes(code))
    return 'connection';
  return proxied ? 'proxy' : 'unknown';
}

/** 使用显式直连 Agent 或本机 Clash ProxyAgent 执行 HTTP 探测。 */
@injectable()
export class UndiciSiteProbe implements SiteProbe {
  private readonly directAgent = new Agent();
  private proxyAgent: { proxyUrl: string; agent: ProxyAgent } | null = null;
  private readonly closingProxyAgents = new Set<Promise<void>>();

  /** 执行请求、完整消费响应体并输出稳定站点结果。 */
  async probe(request: SiteProbeRequest): Promise<SiteResult> {
    const checkedAt = new Date().toISOString();
    const startedAt = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    timer.unref();
    try {
      const response = await fetch(request.url, {
        dispatcher: this.dispatcher(request.proxyUrl),
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'user-agent': 'clash-sentinel/0.0.0' },
      });
      const body = await response.text();
      if (response.status < 200 || response.status >= 400)
        return this.failure(request.target, checkedAt, 'http');
      const status =
        request.target === 'openai_status'
          ? parseOpenAiStatus(body)
          : { serviceStatus: null, incidentSummary: null };
      return {
        target: request.target,
        reachable: true,
        httpStatus: response.status,
        durationMs: Math.max(0, performance.now() - startedAt),
        errorType: null,
        checkedAt,
        ...status,
      };
    } catch (error) {
      return this.failure(
        request.target,
        checkedAt,
        classifyProbeError(error, request.proxyUrl !== null),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** 关闭直连和代理连接池，允许服务进程干净退出。 */
  async close(): Promise<void> {
    const proxyAgent = this.proxyAgent?.agent;
    this.proxyAgent = null;
    await Promise.all([
      this.directAgent.close(),
      ...(proxyAgent ? [proxyAgent.close()] : []),
      ...this.closingProxyAgents,
    ]);
  }

  /** 根据可选代理地址返回复用的 Undici Dispatcher。 */
  private dispatcher(proxyUrl: string | null): Dispatcher {
    if (!proxyUrl) return this.directAgent;
    if (this.proxyAgent?.proxyUrl === proxyUrl) return this.proxyAgent.agent;

    const previousAgent = this.proxyAgent?.agent;
    const agent = new ProxyAgent(proxyUrl);
    this.proxyAgent = { proxyUrl, agent };
    if (previousAgent) this.closeProxyAgent(previousAgent);
    return agent;
  }

  /** 异步关闭已被替换的代理连接池，并在内部消费关闭异常。 */
  private closeProxyAgent(agent: ProxyAgent): void {
    const closing = Promise.resolve()
      .then(() => agent.close())
      .catch(() => undefined);
    this.closingProxyAgents.add(closing);
    void closing.then(() => this.closingProxyAgents.delete(closing));
  }

  /** 创建不含虚假 HTTP 状态或耗时的失败结果。 */
  private failure(
    target: SiteTarget,
    checkedAt: string,
    errorType: SiteErrorType,
  ): SiteResult {
    return {
      target,
      reachable: false,
      httpStatus: null,
      durationMs: null,
      errorType,
      checkedAt,
      serviceStatus: target === 'openai_status' ? 'unknown' : null,
      incidentSummary: null,
    };
  }
}
