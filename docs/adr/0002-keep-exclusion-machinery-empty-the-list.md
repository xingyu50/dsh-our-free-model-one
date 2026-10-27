# 渠道排除机制保留，只清空名单

Status: accepted

2.7.1 用 `src/magpie-policy.js` 单点判定渠道排除：`DENIED_IDS` + `DENIED_TEXT` 两个常量是数据源，`isDeniedChannel` 是判定函数，`POLICY_REFUSED` 是被 `src/magpie-engine.js` 三处 throw/catch 依赖的常量，另有 15 条响应过滤路由与 4 类写操作 403 拦截。

恢复三个渠道后没有渠道需要排除，于是有两个选项：删掉整个机制，或只把名单清空。

选择只清空名单。理由是这套机制与「3. 被谁调用」无关，`src/providers/index.js` 的 `OFFERED_PROVIDERS`、`packages/standalone/providers.mjs:29` 都在调 `isDeniedChannel`，删函数要同时改这两处；而 `magpie-engine.js` 对 `POLICY_REFUSED` 的 throw/catch 是引擎请求路径的一部分，删掉会改动引擎核心。名单清空后 `isDeniedChannel` 恒返回 `false`，用户可见行为与删机制完全相同，代价是多几个恒假分支。

## Consequences

`RESPONSE_FILTERS` 与 `MUTATION_ROUTES` 变成空转 —— 过滤循环仍执行，但匹配不到任何条目，JSON 原样透传。这不影响正确性，但下次若要重新排除某个渠道，改回两个常量即可，无需恢复代码结构。

`src/disclaimer.js` 不能同样「只清空」了就算完：它的 `sections[0]` 会继续向用户宣称「本插件不提供这三个渠道」，与新行为直接矛盾。故 `DISCLAIMER_VERSION` 升到 3 并改写该段文案，靠版本号让已确认过 v2 的用户重读。

`scripts/magpie-policy-test.mjs` 的断言方向整体反转：从「渠道必须缺席」改为「渠道必须存在」。这不是删测试，是把测试从守排除改为守恢复。
