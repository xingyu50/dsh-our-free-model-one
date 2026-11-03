/**
 * OpenCode Zen（账号槽 + 匿名槽平权混合池）渠道的装配描述。
 *
 * 本文件是 `index.ts` 中原 OpenCode 装配块的**原样搬运**，不是重写：options
 * 内容（身份槽、目录拉取、代理、指纹）逐字保留，只把「谁调用
 * `registerOpencodeLlm`」从内联语句改成注册表的一个条目。
 *
 * ⚠️ **条件装配**：`apply()` 的 `config.disableOpencode === true` 时不装配本渠道。
 * 条件在 `index.ts` 组 specs 时判断（`...disableOpencode ? [] : [spec]`），
 * 注册表本身不认识这条开关 —— 它只负责「按顺序装给定的表」。
 *
 * 没有任何 Auth 服务实例：opencode 的凭据、代理、指纹都直接存在账号池上，
 * 故 `createAuth` 返回一个空对象（注册表只要求 `stop?` 可选）。
 *
 * @module channels/opencode
 */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { execFile } from 'node:child_process'
import { registerOpencodeLlm } from '../opencode-adapter.js'
import {
  ensureDefaultAnonymousSlot, listIdentitySlots, type PoolEntrySnapshot,
} from '../opencode-auth.js'
import { OPENCODE } from '../opencode-product.js'
import { deriveProjectId, opencodeUserAgentForVersion } from '../opencode.js'
import { primeOpencodeCapabilities, refreshOpencodeCapabilities } from '../opencode-capability.js'
import { closeAllProxyDispatchers } from '../opencode-proxy.js'
import type { AccountPool } from '../account-pool.js'
import type { ChannelSpec } from '../channel-registry.js'

/** 装配期需要、但不属于 `ChannelHost` 的依赖（账号池由 index.ts 持有）。 */
export interface OpencodeChannelDeps {
  readonly pool: AccountPool
}

/**
 * 懒加载的 OpenCode UA：首个请求要发时才探测本机 opencode 版本，探测一次即缓存。
 *
 * ⚠️ 拿不到**不阻塞、不抛错**，回退 `OPENCODE.defaultUserAgent`：UA 只是一个伪装
 * 维度，服务端并未校验其真实性（opencode2dsh 实测），不值得为此延迟启动。
 * 探测最多等 2 秒；本机没装 opencode 是**正常情况**（匿名通道照样能用）。
 * ⚠️ 用 `execFile` 而非 `exec`：**不经过 shell**，参数不会被解释；带
 * `windowsHide` 免得在 Windows 上闪一个黑框。
 * ⚠️ 缓存 Promise 而非结果：并发首请求只会 spawn 一次探测进程。
 */
function lazyOpencodeUserAgent(): () => string {
  let pending: Promise<string> | undefined
  return () => {
    pending ??= new Promise<string>((resolve) => {
      execFile('opencode', ['--version'], { timeout: 2000, windowsHide: true }, (_err, stdout) => {
        resolve(typeof stdout === 'string' ? stdout : '')
      })
    })
      .then((out) => {
        const version = out.match(/(\d+\.\d+\.\d+)/)?.[1]
        // ⚠️ 探测值必须转成 **v2 形状**（`opencode/latest/<version>/cli`）：
        // 旧实现直接拼 `opencode/<version>` 是 v1 形状，v2 门禁一律 403
        // （见 `opencode.ts` 模块头）。
        return opencodeUserAgentForVersion(version) ?? OPENCODE.defaultUserAgent
      })
      .catch(() => OPENCODE.defaultUserAgent)
    // 同步取值：缓存命中时立刻有值；未命中时用产品默认（不阻塞首个请求）。
    let cached = OPENCODE.defaultUserAgent
    void pending.then((ua) => { cached = ua })
    return cached
  }
}

/**
 * 拉取 Zen 模型目录的超时（毫秒）。
 *
 * ⚠️ 桌面版实测：到 `opencode.ai` 的 fetch 可能**永不 settle**（宿主网络
 * 异常），而 `loadOpencodeCatalog` 的兜底分支只有在内层 Promise **结束**
 * 后才可能执行。挂死时模型列表与用量徽标会同时空白（用户报障 2026-10-02）。
 * 8 秒足够覆盖正常路径（实测首字节 720ms 量级），又不会让 UI 干等太久。
 */
const OPENCODE_CATALOG_TIMEOUT_MS = 8_000

/** 构造 opencode 的注册表条目。 */
export function createOpencodeChannel(deps: OpencodeChannelDeps): ChannelSpec {
  const { pool } = deps
  let adapter: ReturnType<typeof registerOpencodeLlm> | undefined
  return {
    id: OPENCODE.id,
    // opencode 没有老契约 namespace：它从上线起就只走 Channel Pack 设置页，
    // `registerProviderSettings` 的 13 项里从来没有 llm-opencode。
    createAuth: () => ({}),
    registerLlm: (ctx: Context, host) => {
      const opencodeUA = lazyOpencodeUserAgent()
      adapter = registerOpencodeLlm(ctx, {
        identitySlots: async () => listIdentitySlots(
          await Promise.all(pool.listAccountsByProvider(OPENCODE.id).map(async (entry) => {
            const resolved = await ctx.credentials
              .resolve(credentialRef(entry.credentialRef))
              .catch(() => undefined)
            let parsed: { api_key?: string } = {}
            if (resolved !== undefined) {
              try {
                parsed = JSON.parse(resolved.value) as typeof parsed
              } catch {
                // 凭据损坏：回退到匿名凭证，让用户看到「凭据未配置」而不是整条崩掉
              }
            }
            const apiKey = parsed.api_key ?? OPENCODE.anonymousKey
            // ⚠️⚠️ **指纹代次必须以账号池为权威重算**（本任务最容易漏的一步）：
            // 「指纹」按钮只把 generation 写进账号条目
            // （`updateOpencodeFingerprintGeneration`），凭据里的 `fingerprint`
            // 仍是添加账号时的旧值。若直接透传凭据里的 fingerprint，代次涨了而
            // project id **纹丝不动** —— 用户点了「指纹」却什么都没换，且**不报错**，
            // 是最难排查的一类静默失效。
            const generation = Math.max(
              pool.opencodeFingerprintGenerationFor(entry.id),
              0,
            )
            // ⚠️ **identity 选择**：匿名槽的 api_key 全是 `public`，用它派生会让
            // N 条匿名通道拿到**同一个指纹**（彼此无法区分）。故匿名槽改用
            // **条目 id** 作 identity —— 这正是「多个匿名账号各有独立指纹」的实现点。
            const identity = apiKey === OPENCODE.anonymousKey ? entry.id : apiKey
            const snapshot: PoolEntrySnapshot = {
              id: entry.id,
              enabled: entry.enabled,
              apiKey,
              proxy: pool.opencodeProxyFor(entry.id),
              fingerprint: { projectId: deriveProjectId(identity, generation), generation },
            }
            return snapshot
          })),
          // 取值一次即可：`listIdentitySlots` 要的是字符串，不是惰性函数。
          // 首次调用时可能还是产品默认值（探测在后台跑），后续请求才用真机版本 ——
          // 宁可前几次 UA 用兜底值，也不让插件启动阻塞在 2 秒的子进程上。
          opencodeUA(),
        ),
      // ⚠️⚠️ **必须有超时**（真机事故 2026-10-02）：桌面版到 opencode.ai 的
      // fetch 可能**永不 settle**（与同源的 remote.session 故障都是宿主网络问题）。
      // 没有超时 → `loadOpencodeCatalog` 的 try/catch 永远走不到 →
      // `listModels` 永不返回 → **模型列表与徽标同时空白**（用户报障）。
      // 有超时则超时后回退兜底表，UI 立刻可用（只是暂时看不到付费模型）。
        fetchRemoteCatalog: (slot, signal) => fetch(OPENCODE.baseUrl + OPENCODE.modelsPath, {
          headers: { authorization: 'Bearer ' + slot.apiKey },
          // 组合两个信号：调用方给的（取消）+ 自己的超时（防挂死）。
          signal: signal === undefined
            ? AbortSignal.timeout(OPENCODE_CATALOG_TIMEOUT_MS)
            : AbortSignal.any([signal, AbortSignal.timeout(OPENCODE_CATALOG_TIMEOUT_MS)]),
        }),
        disabledModels: () => pool.disabledModelsFor(OPENCODE.id),
        markLimited: async (slotId, modelId, resetAtMs) => {
          // 匿名条目同样落盘：它是池里的一条普通条目，限额标记在面板可见、
          // 可用「重测/清除」恢复（早期把匿名槽当进程内状态，重启即丢）。
          await pool.updateModelRateLimit(slotId, modelId, resetAtMs)
        },
        warn: (message) => ctx.logger.warn('[channel-pack] ' + message),
        // ⚠️ 图片字节桥接：Zen 有多个免费模型实测支持图片输入（big-pickle /
        // space-bunny-free / mimo-v2.6 / mimo-v2.5，2026-10-02 真机验证），
        // 模态由 `opencode-capability.ts` 按远端 models.dev 播报。
        // ⚠️ 不接 `readImageRequest`（缩放桥接）：Zen 免费通道对图片体积的
        // 限制**未实测**，不凭猜测加一层压缩（Qoder/Raccoon 是实测撞到体积
        // 限制才接的）。先发原图，撞到限制再按实测加。
        readImage: host.readImage,
      })
      return adapter
    },
    afterMount: (ctx) => {
      // 保证至少有一条匿名通道（零账号也能用免费模型）。
      //
      // ⚠️ **不 await**：`apply()` 是同步的（不能 await），而这里是异步 IO。
      // 走 fire-and-forget —— 它只是「补一条默认条目」，失败最坏结果是用户
      // 手动点「+ 添加匿名通道」，而 `listIdentitySlots` 每次请求都实时读池，
      // 补完立即生效，不需要等它。
      void ensureDefaultAnonymousSlot(
        (entry) => pool.addAccount(entry),
        (refName, value) => ctx.credentials.set(credentialRef(refName), value),
        () => pool.listAccountsByProvider(OPENCODE.id),
        // ⚠️ 判据是「池里有没有匿名条目」而不是「有没有账号」：用户若主动
        // 删光了匿名通道，那是明确选择，不该每次启动又塞回来（删除会像失灵）。
        () => pool.listAccountsByProvider(OPENCODE.id).some(
          (e) => e.id.startsWith(OPENCODE.id + '-anon-'),
        ),
      ).then((id) => {
        if (id !== '') ctx.logger.info('[channel-pack] 已为 OpenCode 创建默认匿名通道：' + id)
      }).catch((error: unknown) => {
        ctx.logger.warn('[channel-pack] 创建默认 OpenCode 匿名通道失败：' + String(error))
      })
      // 预热模型能力表（models.dev）。
      //
      // ⚠️⚠️ **两条硬约定**（真机事故 2026-10-02）：
      // 1. 渲染路径上**只读同步缓存**，永不 await 网络 —— 我最初在 `listModels`
      //    里 await 这个拉取，而它 5 MB / 慢则 1.4s、宿主网络异常时**永不返回**，
      //    于是模型选择器一直空白（用户报障「一直卡着」）。
      // 2. 拉取完成要**广播目录变更**：能力表是能力判定的来源，DSH 已经用
      //    「纯文本」渲染过一帧，不广播它不会重算（免费模型会一直显示不支持图片）。
      //
      // 首次运行磁盘没缓存时，本次刷新可能晚于首帧几十秒；那段时间能力按纯文本
      // 保守处理（见 opencode-capability.ts 的模块头）。
      primeOpencodeCapabilities()
      refreshOpencodeCapabilities(() => {
        try {
          ctx.emit('llm/adapters-updated')
        } catch (error) {
          ctx.logger.warn('[channel-pack] 广播 OpenCode 能力更新失败：' + String(error))
        }
      })
    },
    dispose: () => {
      // 代理 dispatcher 是常驻连接池：插件卸载必须回收，否则进程退出会挂住。
      // ⚠️ 用仓库既有的 `ctx.effect(() => () => …)` 回收模式；cordis 的 Events
      // 里**没有** `dispose` 事件（`ctx.on('dispose', …)` 直接类型报错）。
      void closeAllProxyDispatchers()
    },
  }
}
