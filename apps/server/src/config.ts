import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { DEFAULT_PROJECT_ROOT } from './project-paths.js';

/** 仅供服务端启动使用的严格配置结构。 */
export const serverConfigSchema = z
  .object({
    logging: z.object({ redactSensitiveData: z.boolean() }).strict(),
    storage: z.object({ redactSensitiveData: z.boolean() }).strict(),
  })
  .strict();

export type ServerConfig = z.infer<typeof serverConfigSchema>;

/** 配置文件默认位于仓库根目录，显式相对路径也以仓库根目录解析。 */
export function resolveServerConfigPath(
  environment: NodeJS.ProcessEnv = process.env,
  projectRoot = DEFAULT_PROJECT_ROOT,
) {
  const configured = environment.CLASH_SENTINEL_CONFIG ?? 'config/default.yaml';
  return isAbsolute(configured) ? configured : resolve(projectRoot, configured);
}

/** 同步读取启动配置；任何缺失或非法内容均由调用方作为启动失败处理。 */
export function loadServerConfig(
  environment: NodeJS.ProcessEnv = process.env,
  projectRoot = DEFAULT_PROJECT_ROOT,
): ServerConfig {
  const path = resolveServerConfigPath(environment, projectRoot);
  return serverConfigSchema.parse(parse(readFileSync(path, 'utf8')));
}
