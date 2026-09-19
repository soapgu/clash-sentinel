# Step 20 MVP 验收记录

日期：2026-09-19。环境：macOS，Node.js 24.2.0，npm 11.3.0。代理执行的故障注入使用测试临时目录、伪造 Clash 文件和模拟控制接口；代理未修改真实订阅。用户随后反馈已完成实际测试，MVP 验收通过；具体操作步骤和观测值未提供。

## 终端运行

| 检查 | 结果 |
| --- | --- |
| `npm run dev` | 开发页面 `127.0.0.1:5173/` 和转发后的 `/api/health` 均返回 200；`Ctrl+C` 停止开发进程。 |
| `npm run build`、`npm start` | 构建通过；Playwright 通过 `npm start` 启动生产服务并完成页面验收。 |
| 隔离生产冒烟 | 独立临时数据库启动；页面和健康接口均返回 200，SSE 建连立即收到 `sync` 通知。发送 `SIGINT` 后日志显示通知中心及服务关闭，3000 端口释放。 |
| 降级启动 | 无 Clash 配置时记录告警，页面仍返回 200；控制接口不可用路径由单元测试覆盖。 |
| 真实 Clash 环境 | 代理在允许本机 Unix socket 访问的环境中只读检查，控制接口可用；以独立数据库读取真实配置启动，健康接口返回 200，`SIGTERM` 后正常退出。用户随后确认已完成实际测试且验收通过；代理未取得具体测试步骤记录。 |

## 隔离故障注入

| 场景 | 结果与证据 |
| --- | --- |
| 断网、网络不确定 | Legacy 适配层测试分别返回 `internet_down`、`internet_uncertain`；健康服务测试验证不会据此误切换。 |
| 入口失败 | Legacy 健康测试返回 `entry_down`；自动切换服务测试验证满足阈值时创建任务并应用合格候选。 |
| 无候选 | Legacy 诊断返回空推荐；自动切换任务以 `no_change` 完成并进入冷却。 |
| 重载或验证失败 | 模拟重载失败时原订阅脚本未留下 `pinnedIp`；恢复状态明确为 `recovery_failed`，自动切换服务测试验证关闭开关。模拟验证失败时返回 `recovered`。 |
| 订阅变化 | 旧诊断用于新订阅时拒绝应用并返回 `PROFILE_CHANGED`；同订阅内容更新返回 `SUBSCRIPTION_UPDATED`。 |

## 质量与发布

- `npm run format:check`、`npm run lint`、`npm run typecheck`、`npm run build` 通过。
- Vitest/Supertest 在允许回环监听的环境中以 `--maxWorkers=2 --testTimeout=15000` 通过 193/193 项。默认 5 秒超时在繁忙环境中曾造成三项 Legacy 测试超时。
- Playwright 默认并行运行在稳定加载态测试后通过 17/17 项；SSE 降级、恢复和页面交互均覆盖。
- 对 `git ls-files --cached --others --exclude-standard` 得到的 186 个候选源码文件审查，未发现数据库、日志、报告、备份或 `.env`。`.gitignore` 排除这些运行数据；GitHub 自动源码包只收录提交文件。发布前须对最终提交再次审查归档列表。
- GitHub 源码包在对应代码提交并通过 CI 后，以该提交创建 `v0.1.0` 标签和 Release；发布结果以 GitHub Release 页面为准。

MVP 验收结论：用户确认实际测试通过。隔离故障注入与用户实测分别记录，不将代理的隔离测试冒称为真实网络切换记录。
