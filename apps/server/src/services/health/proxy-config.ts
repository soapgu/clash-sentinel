import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

/** 从固定 Clash 运行配置解析本机 HTTP 代理地址。 */
export class ClashProxyConfig {
  /** @param runtimeConfigPath Clash 运行配置文件路径。 */
  constructor(private readonly runtimeConfigPath: string) {}

  /**
   * 读取 mixed-port 或 port 并生成仅指向回环地址的代理 URL。
   *
   * @returns 合法代理 URL；配置缺失、不可读或端口非法时返回 null。
   */
  async getProxyUrl(): Promise<string | null> {
    try {
      const document = parse(
        await readFile(this.runtimeConfigPath, 'utf8'),
      ) as Record<string, unknown> | null;
      const port = document?.['mixed-port'] ?? document?.port;
      if (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65_535)
        return null;
      return `http://127.0.0.1:${String(port)}`;
    } catch {
      return null;
    }
  }
}
