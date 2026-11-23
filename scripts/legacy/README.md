# Legacy 适配目录

`clash-entry-ip.sh` 的上游基线为 `soapgu/clash-network-test` 提交
`5dccc377a5e0d0ba90c976458409c97ef3dbf873`。本次同步将上游从 `e565efc`
到 `5dccc37` 的脚本差异合入，包含订阅与运行配置的 DNS 候选发现、单候选端口
测试及新版诊断报告。副本保留 Sentinel 专用的控制接口密钥环境变量、订阅身份
监测和失败恢复状态。后续升级应核对明确的上游提交和这些本地差异，并运行适配层测试。

服务端首版只调用 `status`、`diagnose`、`health`、`apply <IPv4>`、`reset` 和
`rollback`。交互式 `switch`、LaunchAgent 的 `monitor` 子命令和内部 `__probe`
不属于适配层公开能力。

生产运行时脚本会访问 Clash Verge Rev 当前订阅；测试必须通过临时目录和伪造系统
命令覆盖所有路径，禁止读取或修改用户真实 Clash 配置。
