# 恢复渠道而非重写渠道适配器

Status: accepted

本仓库在 2.6.0 移除了 WorkBuddy 国内版、国际版与华为云渠道，到 2.7.1 已删净适配器源码（`vendor/channel-pack/src/` 对 `buddy|workbuddy|codearts` 全仓 0 命中）。现在要恢复这三个渠道，有两个可行动作：从 2.1.0 逐文件迁回，或按 2.7.1 的共享层契约重写实现。

选择迁回 2.1.0 的 15 个文件。理由是这三个渠道的协议细节只存在于代码注释里，且每一条都有实测记录：CodeBuddy 的 `/v2/plugin/auth/token` 只返相对 `expiresIn` 故必须回退解析 JWT `exp`；签到必须用 `checkin-activity-status` 而非 `checkin-status`（后者返占位数据 `active:false`，会误判为活动未开启）；重复领取是 HTTP 400 + 业务码 `10001`，只看状态码会把幂等报成失败；余额接口 `get-user-resource` 的 `data` 是双层嵌套 `data.Response.Data.Accounts[]`，且只累加有效包（某账号实测因此从 155.67 变成 655.67）。重写意味着重新踩这些坑，而迁回能连注释一起保留。

## Consequences

迁回的文件与 2.7.1 的共享层存在四处导出缺口，必须补在共享文件上而不是改在适配器里：`credits.ts` 缺 6 个签到/余额导出、`types.ts` 缺 5 个类型、`index.ts` 缺 3 个 namespace 与装配、`channel-pack-rpc.ts` 缺 6 项服务映射。其中 `credits.ts` 只追加不替换，因为 2.7.1 的 336 行版本已被其他渠道（`loomy`/`raccoon`/`zcode`）依赖。

`credentialExpiresAtMs` 在两处各有一份实现。保留 `buddy.ts` 内那份，不复用 2.7.1 `credential-expiry.ts` 的通用版本 —— 后者参数类型是 `StoredTokenCredential`，不含 CodeBuddy 的 `expiresIn` 回退分支。两份同名函数并存不是重复代码，是两种凭据格式的分别处理。

`auto-checkin.ts` 不能用 2.1.0 的替换。2.7.1 多出的 31 行是 `armNext` 跨天修复，丢掉它会让签到在跨天后停摆。
