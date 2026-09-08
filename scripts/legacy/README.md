# Legacy 适配目录

`clash-entry-ip.sh` 原样来自 `soapgu/clash-network-test` 的提交
`f20177e401d7b7cfa7489896509fa3f11c2ebe23`。升级时必须从明确提交重新复制并运行
本项目的适配层测试，不要直接修改此副本。

服务端首版只调用 `status`、`diagnose`、`health`、`apply <IPv4>`、`reset` 和
`rollback`。交互式 `switch`、LaunchAgent 的 `monitor` 子命令和内部 `__probe`
不属于适配层公开能力。

生产运行时脚本会访问 Clash Verge Rev 当前订阅；测试必须通过临时目录和伪造系统
命令覆盖所有路径，禁止读取或修改用户真实 Clash 配置。
