# Clash Sentinel（Clash 哨兵）

Clash Sentinel 是面向 macOS 与 Clash Verge Rev / Mihomo 的本机连接健康监测和入口 IP 自动恢复服务。

> 当前版本：0.1.0。终端运行与 MVP 验收记录见 [Step 20 验收记录](docs/step-20-acceptance.md)。

## 安装与运行

使用 Node.js 24 LTS 和 npm。项目通过 `.nvmrc` 与 `.node-version` 标识 Node 主版本，CI 同样使用 Node.js 24。
需要 macOS 和已配置的 Clash Verge Rev / Mihomo；缺少 Clash 配置或控制接口时服务会告警并降级启动，页面仍可查看已有记录，检测及配置操作会报告失败。启动前确认所用端口空闲。`.env.example` 列出可选环境变量；程序不会自动加载该文件，如需覆盖请在终端显式导出变量。

```bash
npm ci
npm run dev
```

开发页面：[http://127.0.0.1:5173](http://127.0.0.1:5173)。Koa API 默认监听 `127.0.0.1:4311`，Vite 转发 `/api` 请求。可用 `CLASH_SENTINEL_PORT` 同时覆盖后台端口和开发代理目标。开发命令先构建共享包，再启动共享包监听、后台与前端；按 `Ctrl+C` 停止全部开发进程。

生产构建与运行：

```bash
npm run build
npm start
```

打开 [http://127.0.0.1:4311](http://127.0.0.1:4311)，页面与 API 均由 Koa 提供。端口占用会报错退出，不自动更换端口。按 `Ctrl+C` 停止服务。

`GET /api/health` 仅确认后台进程可以响应，不代表 Clash 或互联网健康。退出时停止接收任务与 SSE 连接，等待已开始的操作及恢复步骤结束后关闭数据库；操作进行中请等待退出完成，不要连续按两次 `Ctrl+C` 强制退出。

### 本机 PM2 与 Nginx 部署

使用 Node.js 24 环境中的 PM2 启动生产构建。后端监听 `127.0.0.1:4020`，前端使用 `/clash-sentinel/` 基础路径。

```bash
npm ci
npm run build:nginx
pm2 start ecosystem.config.cjs --only clash-sentinel
```

将以下配置放入现有 `localhost:8080` 的 `server` 块所加载的路由目录。本机路径为 `/opt/homebrew/etc/nginx/servers/conf.d/clash-sentinel.conf`。

```nginx
location = /clash-sentinel {
    absolute_redirect off;
    return 308 /clash-sentinel/$is_args$args;
}

location /clash-sentinel/ {
    allow 127.0.0.1;
    allow ::1;
    deny all;
    proxy_pass http://127.0.0.1:4020/;
}

location = /clash-sentinel/api/stream {
    allow 127.0.0.1;
    allow ::1;
    deny all;
    proxy_pass http://127.0.0.1:4020/api/stream;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 60s;
}
```

运行 `nginx -t && nginx -s reload`，然后打开 [管理页面](http://localhost:8080/clash-sentinel/)。执行 `curl -fsS http://localhost:8080/clash-sentinel/api/health` 检查后台响应，用 `pm2 logs clash-sentinel` 查看日志。更新时先执行 `npm run build:nginx`，再执行 `pm2 restart ecosystem.config.cjs --only clash-sentinel`。

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
正常运行请保持两个脱敏开关为 `true`。不要提交 `.env`、真实配置、数据库、报告或备份；操作可能重载 Mihomo 并短暂影响代理连接。

Mihomo TCP 控制接口使用 `controller.secret` 认证；未配置时默认使用
`set-your-secret`。若 Clash Verge Rev 使用其他密钥，可复制 `config/default.yaml`
到不纳入 Git 的本机文件，添加 `controller: { secret: "实际密钥" }`，再通过
`CLASH_SENTINEL_CONFIG` 指向该文件并重启 Sentinel。控制接口返回 401/403 时，
页面会显示认证失败提示；请勿将含实际密钥的配置文件提交到仓库。

本地存储使用同步、事务化的 SQLite，默认数据库位于仓库根目录的
`.state/clash-sentinel.db`，不受 npm workspace 当前目录影响。可以通过
`CLASH_SENTINEL_DB_PATH` 环境变量或
`SqliteStore` 构造参数覆盖路径；测试始终使用独立临时数据库。启动时会执行版本化迁移，
并将上次进程遗留的排队中或运行中任务标记为“服务重启中断”，不会自动重放配置修改。
数据库保存策略、当前快照、站点历史、最近诊断候选、任务和事件，不保存 Legacy 原始报告、
完整订阅正文、Mihomo 密钥或非必要本机路径。关闭存储脱敏只影响服务启动后的新写入，
不会恢复已经脱敏的历史内容，也不会自动清洗历史明文。站点历史及普通、关键事件分别按数量上限清理，
当前快照和最近诊断不参与历史清理。
设计文档导航：

- [服务端设计总览](docs/server-design.md)：系统边界、组件、关键流程、生命周期、安全和设计决策。
- [服务端类与接口设计](docs/server-class-design.md)：生产类、基础接口、公共成员和分系统 UML 类图。
- [前端设计总览](docs/frontend-design.md)：当前页面能力、数据流、状态模型、交互和质量边界。
- [Dashboard 实现设计](docs/dashboard-design.md)：当前组件、Hooks、纯模块、样式分层和维护约束。
- [API 设计](docs/api-design.md)：HTTP/SSE 契约、任务语义和错误码。
- [数据库设计](docs/database-design.md)：表结构、迁移、事务、恢复和保留规则。
- [TSyringe 专题](docs/tsyringe.md)：依赖注入机制、容器作用域和项目约束。
- [高保真可交互原型](docs/design/high-fidelity/README.md)：页面布局、状态表达和交互基准。

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npx playwright install chromium
npm run test:e2e
```

`npm run test:e2e` 会构建并启动隔离的测试服务，要求端口 `4312` 空闲。`npm run format` 用于格式化新增工程文件，已验收的设计文档和图稿排除在格式化范围之外。

GitHub Actions 在 push 和 pull request 时使用 macOS runner 执行上述检查，失败时保存 Playwright 报告与追踪文件。本阶段未配置自动发布或部署。
首版发布说明及已知限制见 [v0.1.0 发布说明](docs/releases/v0.1.0.md)。发布物为 GitHub 自动生成的源码包，不包含本机运行数据；检出后需自行安装依赖并构建。

## 核心能力

### 定期健康检测

后台定期检测本机互联网、当前入口 IP 和代理实际访问状态，区分本机断网、入口故障、代理异常和状态不确定，并记录检测历史与连续失败次数。

### 入口 IP 锁定

当前版本暂停手动锁定、自动切换和手动回滚。升级时会关闭已保存的自动切换。已有锁定可以通过「解除锁定」恢复为订阅入口。

### Web 管理

通过仅限本机访问的 Web 页面查看连接状态、候选 IP 和事件记录，并执行立即检测、重新诊断和解除锁定。未锁定时仍可根据国内网络和代理站点的探测结果查看健康状态。

严格诊断从当前订阅和运行配置中的 UDP、TCP、DoH 上游及 Clash 本地 DNS 补充候选，
只有一个 IPv4 时也会测试。候选卡片显示本轮查询的来源摘要，展开「来源详情」可查看实际应答端点。

## 首版边界

- 支持 macOS 与 Clash Verge Rev / Mihomo。
- 仅管理 Clash Verge Rev 当前选择的订阅。
- “切换 IP”仅指切换同一入口域名的候选 IPv4，不是切换代理节点或更换出口 IP。
- Web 管理服务仅监听本机地址，不开放公网控制。
- 支持在终端运行，也可由本机 PM2 托管并通过 Nginx 访问。
- 暂不支持 Android 自动控制、跨平台运行、多设备管理和节点优选。

## 开发路线

1. **监测与可视化**：实现后台检测、状态存储和只读状态页面。
2. **手动管理闭环**：实现诊断、切换、解除锁定和回滚操作。
3. **自动恢复闭环**：实现故障阈值、自动切换和冷却保护，完成终端运行版验收。

完整功能规划和验收标准见 [PROJECT_PLAN.md](PROJECT_PLAN.md)，具体开发顺序和阶段检查清单见 [STEP.md](STEP.md)。

## 基线项目

本项目以 [soapgu/clash-network-test](https://github.com/soapgu/clash-network-test) 为功能基线，继承其入口域名识别、候选 IP 诊断、配置锁定、Mihomo 重载验证及失败回滚思路，并在此基础上演进为长期运行的本机服务。
