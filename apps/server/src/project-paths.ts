import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 从 server 的 src 或 dist 模块位置稳定回溯到仓库根目录。 */
export function projectRootFromModuleUrl(moduleUrl: string) {
  return resolve(fileURLToPath(new URL('../../../', moduleUrl)));
}

/** 与进程启动目录无关的 Clash Sentinel 仓库根目录。 */
export const DEFAULT_PROJECT_ROOT = projectRootFromModuleUrl(import.meta.url);

/** 服务运行时使用的全部本机路径。 */
export interface RuntimePaths {
  projectRoot: string;
  databasePath: string;
  legacyScriptPath: string;
  appDir: string;
  legacyStateDir: string;
  legacyReportDir: string;
  legacyBackupDir: string;
  runtimeConfigPath: string;
}

/** 将显式相对路径也锚定到项目根目录，避免 workspace cwd 改变其含义。 */
function fromProjectRoot(projectRoot: string, value: string) {
  return isAbsolute(value) ? value : resolve(projectRoot, value);
}

/** 按环境变量优先、项目根目录兜底的规则集中解析运行路径。 */
export function resolveRuntimePaths(
  environment: NodeJS.ProcessEnv = process.env,
  projectRoot = DEFAULT_PROJECT_ROOT,
): RuntimePaths {
  const root = resolve(projectRoot);
  const appDir = fromProjectRoot(
    root,
    environment.CLASH_APP_DIR ||
      resolve(
        homedir(),
        'Library/Application Support/io.github.clash-verge-rev.clash-verge-rev',
      ),
  );
  return {
    projectRoot: root,
    databasePath: fromProjectRoot(
      root,
      environment.CLASH_SENTINEL_DB_PATH || '.state/clash-sentinel.db',
    ),
    legacyScriptPath: fromProjectRoot(
      root,
      environment.CLASH_SENTINEL_LEGACY_SCRIPT_PATH ||
        'scripts/legacy/clash-entry-ip.sh',
    ),
    appDir,
    legacyStateDir: fromProjectRoot(
      root,
      environment.CLASH_ENTRY_STATE_DIR || '.state/legacy',
    ),
    legacyReportDir: fromProjectRoot(
      root,
      environment.CLASH_ENTRY_REPORT_DIR || 'reports/legacy',
    ),
    legacyBackupDir: environment.CLASH_ENTRY_BACKUP_DIR
      ? fromProjectRoot(root, environment.CLASH_ENTRY_BACKUP_DIR)
      : resolve(appDir, 'entry-ip-backups'),
    runtimeConfigPath: environment.CLASH_RUNTIME_CONFIG
      ? fromProjectRoot(root, environment.CLASH_RUNTIME_CONFIG)
      : resolve(appDir, 'clash-verge.yaml'),
  };
}
