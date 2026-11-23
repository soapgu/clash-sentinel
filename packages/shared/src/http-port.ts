/** 解析服务端与开发代理共用的监听端口。 */
export function resolveHttpPort(value: string | undefined): number {
  if (value === undefined) return 4311;

  const port = Number(value);
  if (!/^\d+$/.test(value) || port < 1 || port > 65_535) {
    throw new Error('CLASH_SENTINEL_PORT 必须是 1 到 65535 之间的十进制整数');
  }
  return port;
}
