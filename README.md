# Clash Sentinel（Clash 哨兵）

Clash Sentinel 是面向 macOS 与 Clash Verge Rev / Mihomo 的本机连接健康监测和入口 IP 自动恢复服务。

> 当前状态：工程骨架、Legacy 适配层、本地 SQLite、Koa API、定时健康检测、SSE、正式 Web 看板和手动操作闭环已完成。页面已支持五类手动动作、任务恢复跟踪和监测设置编辑；自动切换留待下一阶段实现。

## 安装与运行

使用 Node.js 24 LTS 和 npm。项目通过 `.nvmrc` 与 `.node-version` 标识 Node 主版本，CI 同样使用 Node.js 24。

```bash
npm ci
npm run dev
```

开发页面：[http://127.0.0.1:5173](http://127.0.0.1:5173)。Koa API 监听 `127.0.0.1:3000`，Vite 转发 `/api` 请求。开发命令先构建共享包，再启动共享包监听、后台与前端；按 `Ctrl+C` 停止全部开发进程。

生产构建与运行：

```bash
npm run build
npm start
```

打开 [http://127.0.0.1:3000](http://127.0.0.1:3000)，页面与 API 均由 Koa 提供。端口占用会报错退出，不自动更换端口。按 `Ctrl+C` 停止服务。

`GET /api/health` 仅确认后台进程可以响应，不代表 Clash 或互联网健康。占位页通过真实请求显示后台连接结果。

## 工程与检查

- `apps/server`：Koa 应用与独立启动入口。
- `apps/web`：React + Vite、React Router 和 TanStack Query。
- `packages/shared`：共享健康、策略、站点、诊断、任务和事件 Schema 与 TypeScript 类型。
- `scripts/legacy`：固定来源版本的 Clash Shell 能力，由服务端类型化适配层调用。

Legacy 适配层使用参数数组启动脚本，不经过 Shell 拼接；为不同操作设置独立超时，
超时后终止整个进程组。诊断报告、健康状态和控制台结果会转换为共享领域类型，
命令日志只通过 Winston Console Transport 输出类别、耗时、退出码和输出字节数，
不会记录 stdout、stderr、Token 或完整配置。该能力当前仅供后台内部调用，不提供业务 HTTP 接口。

服务端日志格式为 `[时间] [级别] 模块:子模块 内容`。开发环境输出 `DEBUG` 及以上，
生产环境输出 `INFO` 及以上；仅终端 TTY 启用颜色，设置 `NO_COLOR` 或重定向输出时
自动使用无 ANSI 控制码的纯文本。在不提供 TTY 的终端中可用 `FORCE_COLOR=1 npm run dev`
强制开启颜色，`FORCE_COLOR=0` 则强制关闭；`FORCE_COLOR` 的优先级高于 `NO_COLOR`。
日志只输出到控制台，不创建应用日志文件；
`requestId`、`taskId` 和 `runId` 始终完整输出。

服务启动时严格读取仓库根目录的 `config/default.yaml`。可用
`CLASH_SENTINEL_CONFIG` 指定替代 YAML；相对路径仍以仓库根目录解析。配置缺失、YAML
非法、字段缺失、类型错误或出现未知字段时服务会安全失败并以退出码 1 结束。配置仅在启动时
读取，不支持热更新，也不通过 HTTP API 或 SQLite 暴露。日志与 SQLite 脱敏分别由
`logging.redactSensitiveData` 和 `storage.redactSensitiveData` 控制，默认均为 `true`；设为
`false` 会在对应范围完整保留凭据、URL 和本机路径，存在明确的敏感信息泄露风险。

本地存储使用同步、事务化的 SQLite，默认数据库位于仓库根目录的
`.state/clash-sentinel.db`，不受 npm workspace 当前目录影响。可以通过
`CLASH_SENTINEL_DB_PATH` 环境变量或
`SqliteStore` 构造参数覆盖路径；测试始终使用独立临时数据库。启动时会执行版本化迁移，
并将上次进程遗留的运行中任务标记为“服务重启中断”，不会自动重放配置修改。
数据库保存策略、当前快照、站点历史、最近诊断候选、任务和事件，不保存 Legacy 原始报告、
完整订阅正文、Mihomo 密钥或非必要本机路径。关闭存储脱敏只影响服务启动后的新写入，
不会恢复已经脱敏的历史内容，也不会自动清洗历史明文。站点历史及普通、关键事件分别按数量上限清理，
当前快照和最近诊断不参与历史清理。
完整表结构、关系、事务和安全规则见[数据库设计文档](docs/database-design.md)。
接口契约、任务语义和错误码见 [API 设计文档](docs/api-design.md)。
页面布局、状态表达和交互基准见[高保真可交互原型](docs/design/high-fidelity/README.md)。

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npx playwright install chromium
npm run test:e2e
```

`npm run test:e2e` 会构建并启动生产服务，要求端口 3000 空闲。`npm run format` 用于格式化新增工程文件，已验收的设计文档和图稿排除在格式化范围之外。

GitHub Actions 在 push 和 pull request 时使用 macOS runner 执行上述检查，失败时保存 Playwright 报告与追踪文件。本阶段未配置自动发布或部署。

## 核心能力

### 定期健康检测

后台定期检测本机互联网、当前入口 IP 和代理实际访问状态，区分本机断网、入口故障、代理异常和状态不确定，并记录检测历史与连续失败次数。

### 故障自动切换

确认入口故障后，从同一入口域名解析出的候选 IPv4 中选择合格地址，自动备份、切换、重载并验证代理连接；操作失败时恢复原配置。

### Web 管理

通过仅限本机访问的 Web 页面查看连接状态、候选 IP 和事件记录，并执行立即检测、重新诊断、手动切换、解除锁定及回滚等操作。

## 首版边界

- 支持 macOS 与 Clash Verge Rev / Mihomo。
- 仅管理 Clash Verge Rev 当前选择的订阅。
- “切换 IP”仅指切换同一入口域名的候选 IPv4，不是切换代理节点或更换出口 IP。
- Web 管理服务仅监听本机地址，不开放公网控制。
- 自动切换默认关闭，由用户主动启用。
- 首次锁定由用户诊断并确认应用合格 IP，完成后才可启用自动切换；未锁定时仍可查看站点监测。
- 首版通过终端运行，LaunchAgent、登录自启动和安装器留待后续版本。
- 暂不支持 Android 自动控制、跨平台运行、多设备管理和节点优选。

## 开发路线

1. **监测与可视化**：实现后台检测、状态存储和只读状态页面。
2. **手动管理闭环**：实现诊断、切换、解除锁定和回滚操作。
3. **自动恢复闭环**：实现故障阈值、自动切换和冷却保护，完成终端运行版验收。

完整功能规划和验收标准见 [PROJECT_PLAN.md](PROJECT_PLAN.md)，具体开发顺序和阶段检查清单见 [STEP.md](STEP.md)。

## 基线项目

本项目以 [soapgu/clash-network-test](https://github.com/soapgu/clash-network-test) 为功能基线，继承其入口域名识别、候选 IP 诊断、配置锁定、Mihomo 重载验证及失败回滚思路，并在此基础上演进为长期运行的本机服务。
