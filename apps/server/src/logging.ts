import { format, transports, createLogger, type Logger } from 'winston';

/** 服务端日志允许使用的固定模块名。 */
export type LogScope =
  | 'app:bootstrap'
  | 'http:access'
  | 'sse:stream'
  | 'task:service'
  | 'health:check'
  | 'health:scheduler'
  | 'settings:service'
  | 'legacy:adapter'
  | 'storage:sqlite';

/** 服务端统一使用的四个日志等级。 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 日志附加字段；输出前统一脱敏并渲染为 key=value。 */
export type LogMetadata = Record<string, unknown>;

/** 业务层依赖的窄日志接口，隔离具体 Winston 类型。 */
export interface AppLogger {
  debug(scope: LogScope, message: string, metadata?: LogMetadata): void;
  info(scope: LogScope, message: string, metadata?: LogMetadata): void;
  warn(scope: LogScope, message: string, metadata?: LogMetadata): void;
  error(scope: LogScope, message: string, metadata?: LogMetadata): void;
  close(): Promise<void>;
}

export interface CreateAppLoggerOptions {
  environment?: NodeJS.ProcessEnv;
  /** 是否移除日志中的凭据、URL 参数、本机路径和堆栈敏感文本。 */
  redactSensitiveData?: boolean;
  isTTY?: boolean;
  now?: () => Date;
  transport?:
    | InstanceType<typeof transports.Stream>
    | InstanceType<typeof transports.Console>;
}

const LEVELS: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const ANSI = {
  reset: '\u001B[0m',
  gray: '\u001B[90m',
  green: '\u001B[32m',
  yellow: '\u001B[33m',
  red: '\u001B[31m',
  cyan: '\u001B[36m',
} as const;

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: ANSI.gray,
  info: ANSI.green,
  warn: ANSI.yellow,
  error: ANSI.red,
};

const SENSITIVE_KEY =
  /(?:token|secret|password|authorization|cookie|api[-_]?key|auth(?:entication)?)/i;
const URL_VALUE = /^https?:\/\//i;
const LOCAL_PATH = /\/(?:Users|private|tmp|var|Volumes)\/[^\s)]+/g;

function sanitizeText(value: string) {
  return value
    .replace(LOCAL_PATH, '[PATH]')
    .replace(
      /((?:token|secret|password|authorization)\s*[:=]\s*)\S+/gi,
      '$1[REDACTED]',
    );
}

/** URL 只保留协议、主机和路径，移除凭据、查询参数及片段。 */
function sanitizeUrl(value: string) {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '[invalid-url]';
  }
}

function sanitizeValue(
  key: string,
  value: unknown,
  redactSensitiveData: boolean,
): unknown {
  if (typeof value === 'number' && /Ms$/.test(key)) return Math.round(value);
  if (redactSensitiveData && SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    if (!redactSensitiveData) return value;
    return URL_VALUE.test(value) ? sanitizeUrl(value) : sanitizeText(value);
  }
  if (Array.isArray(value))
    return value.map((item) => sanitizeValue(key, item, redactSensitiveData));
  if (value && typeof value === 'object' && !(value instanceof Error))
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        sanitizeValue(childKey, childValue, redactSensitiveData),
      ]),
    );
  return value;
}

function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string')
    return /\s|[="|]/.test(value) ? JSON.stringify(value) : value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  if (Array.isArray(value)) return `[${value.map(formatValue).join(',')}]`;
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

/** 按服务器本地时区生成 YYYY-MM-DD HH:mm:ss:SSS。 */
export function formatLocalTimestamp(date: Date) {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}:${pad(date.getMilliseconds(), 3)}`;
}

/** 将日志字段渲染为自然文本；供 Winston formatter 和单元测试复用。 */
export function formatLogLine(
  level: LogLevel,
  scope: LogScope,
  message: string,
  metadata: LogMetadata,
  timestamp: string,
  useColors: boolean,
  redactSensitiveData = true,
) {
  const safeEntries = Object.entries(metadata)
    .filter(
      ([key, value]) =>
        !['error', 'level', 'message', 'scope', 'timestamp'].includes(key) &&
        value !== undefined,
    )
    .map(
      ([key, value]) =>
        `${key}=${formatValue(sanitizeValue(key, value, redactSensitiveData))}`,
    );
  const suffix = safeEntries.length ? ` | ${safeEntries.join(' ')}` : '';
  const upperLevel = level.toUpperCase();
  const levelText = useColors
    ? `${LEVEL_COLOR[level]}${upperLevel}${ANSI.reset}`
    : upperLevel;
  const scopeText = useColors ? `${ANSI.cyan}${scope}${ANSI.reset}` : scope;
  let output = `[${timestamp}] [${levelText}] ${scopeText} ${message}${suffix}`;
  const error = metadata.error;
  if (error instanceof Error && error.stack) {
    const indented = (
      redactSensitiveData ? sanitizeText(error.stack) : error.stack
    )
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n');
    output += `\n${indented}`;
  }
  return output;
}

class WinstonAppLogger implements AppLogger {
  private closePromise: Promise<void> | null = null;

  constructor(private readonly logger: Logger) {}

  debug(scope: LogScope, message: string, metadata: LogMetadata = {}) {
    this.write('debug', scope, message, metadata);
  }

  info(scope: LogScope, message: string, metadata: LogMetadata = {}) {
    this.write('info', scope, message, metadata);
  }

  warn(scope: LogScope, message: string, metadata: LogMetadata = {}) {
    this.write('warn', scope, message, metadata);
  }

  error(scope: LogScope, message: string, metadata: LogMetadata = {}) {
    this.write('error', scope, message, metadata);
  }

  async close() {
    this.closePromise ??= new Promise<void>((resolvePromise) => {
      this.logger.once('finish', resolvePromise);
      this.logger.once('error', resolvePromise);
      try {
        this.logger.end();
      } catch {
        resolvePromise();
      }
    });
    await this.closePromise;
  }

  private write(
    level: LogLevel,
    scope: LogScope,
    message: string,
    metadata: LogMetadata,
  ) {
    try {
      this.logger.log(level, message, { scope, ...metadata });
    } catch {
      // 日志格式化或输出失败不得影响业务流程。
    }
  }
}

/** 创建仅输出到 Console 的生产日志实例。 */
export function createAppLogger(
  options: CreateAppLoggerOptions = {},
): AppLogger {
  const environment = options.environment ?? process.env;
  const useColors =
    environment.FORCE_COLOR === undefined
      ? (options.isTTY ?? Boolean(process.stdout.isTTY)) &&
        environment.NO_COLOR === undefined
      : environment.FORCE_COLOR !== '0';
  const now = options.now ?? (() => new Date());
  const redactSensitiveData = options.redactSensitiveData ?? true;
  const output = options.transport ?? new transports.Console();
  const logger = createLogger({
    levels: LEVELS,
    level: environment.NODE_ENV === 'production' ? 'info' : 'debug',
    transports: [output],
    format: format.printf((info) =>
      formatLogLine(
        info.level as LogLevel,
        String(info.scope) as LogScope,
        String(info.message),
        info,
        formatLocalTimestamp(now()),
        useColors,
        redactSensitiveData,
      ),
    ),
  });
  logger.on('error', () => undefined);
  return new WinstonAppLogger(logger);
}

/** 默认用于测试替身和可选依赖的无副作用日志器。 */
export const noopLogger: AppLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  close: async () => undefined,
};
