import type { ApiErrorCode, ApiErrorDetails } from '@clash-sentinel/shared';

/** Koa 控制器和中间件之间传递的稳定公开错误。 */
export class ApiError extends Error {
  /**
   * 创建不包含敏感原始输入的 API 错误。
   *
   * @param status HTTP 状态码。
   * @param code 稳定 API 错误码。
   * @param message 面向调用方的中文说明。
   * @param details 可选脱敏上下文。
   */
  constructor(
    public readonly status: number,
    public readonly code: ApiErrorCode,
    message: string,
    public readonly details?: ApiErrorDetails,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
