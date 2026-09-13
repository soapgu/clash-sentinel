/** 本地存储验证、状态转换或序列化失败。 */
export class StorageError extends Error {
  constructor(
    public readonly code:
      'VALIDATION' | 'NOT_FOUND' | 'INVALID_TRANSITION' | 'SERIALIZATION',
    message: string,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}
