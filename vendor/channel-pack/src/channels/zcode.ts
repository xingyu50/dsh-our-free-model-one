/**
 * ZCode（智谱代码助手免费线）渠道的装配描述。
 *
 * 本文件是 `index.ts` 中原 ZCode 装配块的**原样搬运**（options 与注释逐字保留），
 * 只把宿主依赖（账号池、图片桥接、上下文）改成注册表注入。
 *
 * @module channels/zcode
 */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { ZcodeAuth } from '../zcode-auth.js'
import { registerZcodeLlm } from '../zcode-adapter.js'
import { ZCODE } from '../zcode-product.js'
import { ZCODE_CAPTCHA_FALLBACK } from '../zcode-captcha.js'
import type { CarrierOutcome } from '../captcha-carrier.js'
import type { ZcodeCredential } from '../zcode.js'
import type { ZcodeRemoteModelLike } from '../zcode-product.js'
import type { AccountPool } from '../account-pool.js'
import type { ChannelAuthInstance, ChannelHost, ChannelSpec } from '../channel-registry.js'
import { reportLedgerAccount } from '../token-ledger.js'

/** ZCode 的 Auth 在注册表最小接口之外的额外能力。 */
export interface ZcodeChannelAuth extends ChannelAuthInstance {
  current(): Promise<ZcodeCredential | undefined>
  refreshAll(pool: AccountPool): Promise<void>
  fetchCaptchaConfig(): Promise<{ region: string; prefix: string; sceneId: string } | undefined>
  mintCaptcha(config: { region: string; prefix: string; sceneId: string }, options?: { signal?: AbortSignal }): Promise<string>
  mintCaptchaParam(config: { region: string; prefix: string; sceneId: string }, options?: { signal?: AbortSignal }): Promise<CarrierOutcome>
  mintCaptchaAfterRejection(outcome: CarrierOutcome, config: { region: string; prefix: string; sceneId: string }, options?: { signal?: AbortSignal }): Promise<CarrierOutcome>
  fetchRemoteModelsOnly(pool?: AccountPool): Promise<ZcodeRemoteModelLike[]>
  refreshAccountCredential(ref: string, pool: AccountPool, accountId: string): Promise<void>
}

/** 装配期需要、但不属于 `ChannelHost` 的依赖。 */
export interface ZcodeChannelDeps {
  readonly pool: AccountPool
}

/**
 * @param deps - 账号池
 * @returns 供 `mountChannels` 装配的 spec
 */
export function createZcodeChannel(deps: ZcodeChannelDeps): ChannelSpec {
  const { pool } = deps
  let authContext: Context = undefined as unknown as Context
  let zcodeAuth: ZcodeAuth | undefined
  let zcodeAdapter: ReturnType<typeof registerZcodeLlm> | undefined
  let resolveZcodeCaptchaConfig: () => Promise<{ region: string; prefix: string; sceneId: string }>
  /**
   * 「本次 ZCode 请求**实际使用**的账号 id」。
   *
   * ## 为什么需要（与 `activeQoderAccountId` 同因）
   *
   * 额度受限时适配器要**标记失败的账号**，而它能拿到的只有这个回调。
   * 池的选号是即时决策，且**切号后回调不会跟着变** —— 若适配器改用
   * 「池当前的默认账号」，切到 B 之后失败时会**再标记一次 A**，
   * B 从未被标记，下次取号又把 B 选中，于是在 A/B 之间反复空转
   * （`qoder-adapter.ts` 的 `switchAccountOnQuota` 注释里记了这条实测）。
   *
   * ⇒ 在 `resolveCredential` 里记录**实际返回的那个账号**，供适配器查询。
   */
  const activeZcodeAccountId = new Map<string, string | undefined>()
  return {
    id: ZCODE.id,
    namespace: 'llm-zcode',
    createAuth: (ctx) => {
      authContext = ctx
      zcodeAuth = new ZcodeAuth(ctx, {
        accountPool: pool,
        /**
         * ★ 二期内部载体（`src/captcha-carrier.ts`）的诊断日志。
         *
         * 那两条告警（「内部载体的 param 被上游拒（第 N 次）」「累计拒 3 次 ⇒ 本次运行禁用
         * 内部载体」）是排查「内部载体为什么没起作用 / 为什么被自动关掉」的**唯一**线索，
         * 缺省不接就等于线上什么都看不见。
         * ⚠ 取 logger 用两级可选链（同文件既有的 `log` / `makeReadImageRequest` 写法）：
         *   宿主某些形态不给 logger，写成点号直调会让调用点所在的产出路径抛 TypeError。
         */
        carrierLog: (message: string) => {
          ctx.logger?.warn?.(message)
        },
      })
      return zcodeAuth as unknown as ChannelAuthInstance
    },
    registerLlm: (ctx: Context, host: ChannelHost) => {
      const zcode = zcodeAuth as unknown as ZcodeChannelAuth
      /**
       * captcha 配置：优先向服务端索取，失败回退内置兜底值。
       *
       * ## ⚠ 这里**不再**做缓存（2026-10-01 修正）
       *
       * 旧实现是 `??=` 的**永久缓存**，两个缺陷（都已实测确认）：
       *
       * 1. **服务端换 `sceneId`／灰度切换后永不生效**（必须重启宿主才能跟上）；
       * 2. **首次拉取失败会被永久固化** —— `??=` 连「回退到兜底值」这个结果
       *    一起记住，此后即使服务端恢复也不会重试。
       *
       * 正确做法是官方 `f3()` 的语义：**60 秒 TTL + 在飞去重、失败不缓存**。
       * 那个能力已下沉到 `ZcodeAuth.fetchCaptchaConfig()`
       *（见其 `captchaConfigCacheInstance`），故这里只做「拿 → 回退」的编排。
       */
      resolveZcodeCaptchaConfig = async () => {
        const remote = await zcode.fetchCaptchaConfig().catch(() => undefined)
        if (remote !== undefined) {
          zcodeAdapter?.setCaptchaConfig(remote)
          return remote
        }
        return ZCODE_CAPTCHA_FALLBACK
      }
      zcodeAdapter = registerZcodeLlm(ctx, {
          credentialRef: credentialRef(ZCODE.defaultCredentialRef),
          resolveCredential: async (modelId?: string) => {
            // 只从 zcode 自己的账号池取账号，回退到自己的单凭据 ref，
            // 保证不会串用其它 provider 的凭据。
            // provider 实参用 ZCODE.id 而非字面量：写死字面量在改名/多产品场景下

            const available = await pool.getAvailableAccount(ZCODE.id, modelId ?? '')
            /**
             * `getAvailableAccount` 的凭据类型是历史遗留的联合类型，
             * 与 `ZcodeCredential` 无充分重叠，故经 `unknown` 转换。
             * 运行时安全性由 provider 过滤保证：查询用 `ZCODE.id`，取到的必是 zcode 凭据。
             */
            if (available) {
              // 记下**实际返回的**账号：额度受限时适配器要标记的是它。
              activeZcodeAccountId.set(ZCODE.id, available.entry.id)
              // Token 账本（第 2 期）：回报「本笔请求解析出的账号」。
              reportLedgerAccount(ZCODE.id, available.entry.id)
              return available.credential as unknown as ZcodeCredential
            }
            /**
             * 账号池里没有条目时，落到 `ZcodeAuth.current()` ——
             * 它已经实现了「账号池 → 单凭据 ref」的解析顺序。
             * ⚠ 不要在这里重复实现那条优先级（重复必然漂移）。
             *
             * ⚠ 同时**清空**记录：没有账号条目可标记，留着旧 id 会误伤一个无辜账号。
             */
            activeZcodeAccountId.set(ZCODE.id, undefined)
            return await zcode.current()
          },
          refresh: async () => {
            /**
             * ⚠ ZCode **没有** refresh 端点（与 Loomy 恒 false 同类，但原因不同）：
             * 凭据是**静态**的（登录一次就固定下来，JWT 里没有 `exp`）。
             *
             * 这里做的是「重读凭据并回写账号条目」，让用户重新登录后不重启即可生效。
             *
             * ⚠⚠ **绝不能用 `current()` + `getAvailableAccount()` 的组合**（审查发现的
             * 真实缺陷，与 `refreshAll` 里记录的那个数据破坏同类）：`current()` 会**先读池**
             * 且**不看 `enabled`**（它按数组顺序取第一个能解析的），而 `getAvailableAccount`
             * **会过滤 `enabled`** —— 两者选的可能是**不同账号**，于是「把 A 的凭据写进 B 的
             * ref」，30 分钟一轮就会串掉整池。
             * 正确做法是交给 `refreshAll`：它逐账号读**自己的** ref、写回**自己的** ref。
             */
            await zcode.refreshAll(pool)
          },
          // ⚠ captcha 是**一次性**的 —— 每次调用都必须现产一个新 param。
          // 走 `zcode.mintCaptcha`：整个插件**共用一台**常驻浏览器
          //（适配器自建会变成两台，白占 200MB）。
          //
          // ⚠ `options.signal` 必须继续往下传：captcha 侧的取页等待与建连历史上有
          // 无超时的路径，不传就等于「用户点停止也停不下来」（真实缺陷，2026-09-29）。
          mintCaptcha: async (options?: { signal?: AbortSignal }) => {
            const config = await resolveZcodeCaptchaConfig()
            return await zcode.mintCaptcha(config, options)
          },
          /**
           * ★ 二期内部载体：推理热路径取 param 走**载体链**（内部供给槽优先，等不到才落
           * 上面那条 chromium 链）。与 `mintCaptcha` 的差别只有「返回值带来源」这一层。
           *
           * ⚠ 这两条回调**必须都在**：少接一条，被 `3007` 拒的那一发就退回普通入口重新取，
           *   归因（内部 vs chromium）就此丢失 —— 累计拒绝到阈值的自动禁用也就永远到不了。
           * ⚠ 载体链不可用（`DSH_ZCODE_INTERNAL_CARRIER=0` / web 版从未收到贡献）时
           *   `zcode.mintCaptchaParam` 自己会退回那条 chromium 链 ⇒ 这里不需要判断开关。
           */
          mintCaptchaParam: async (options?: { signal?: AbortSignal }) => {
            const config = await resolveZcodeCaptchaConfig()
            return await zcode.mintCaptchaParam(config, options)
          },
          mintCaptchaAfterRejection: async (
            outcome: CarrierOutcome,
            options?: { signal?: AbortSignal },
          ) => {
            const config = await resolveZcodeCaptchaConfig()
            return await zcode.mintCaptchaAfterRejection(outcome, config, options)
          },
          /**
           * captcha 的 region —— **只是「连配置都没有」时的最后兜底**，正常路径不生效。
           *
           * ⚠ region 必须与产 param 的那份配置同源（真实缺陷，Gitee issue IKJNPS；
           *   领取路径与推理路径各有一个实例）。上面三个 mint 回调都会走
           *   `resolveZcodeCaptchaConfig()`，它把远端配置写进适配器
           *   （`setCaptchaConfig`）⇒ 组头时适配器读的是 `captchaConfig.region`，
           *   这里这个字面量只在自建浏览器那条腿（没有任何注入回调）且从未拉到配置时兜底。
           *
           * ⚠ 别把它写回「无条件生效」——服务端下发的 region 因账号/渠道而异
           * （作者账号是 `cn`，z.ai 国际渠道实测 `sgp`），写死只会在 cn 区账号上碰巧正确。
           */
          captchaRegion: ZCODE_CAPTCHA_FALLBACK.region,
          /**
           * 诊断日志：把「先探后取」的前置耗时与补产事件接到宿主 logger。
           *
           * ⚠ **必须注入** —— 适配器里那三条出口（`zcode-adapter.ts` 的
           * `前置耗时 …`、`上游要求 captcha（3007）…`、`captcha 被拒（3007），换新 param 重试`）
           * 全走 `this.options.log?.()`，缺省**完全不输出**（见 `ZcodeAdapterOptions.log`
           * 的注释）。不接上就是：带 captcha 的那一发比不带的慢一次 mint（稳态约 0.4–0.5
           * 秒、首次含 chromium 冷启动 4.2 秒；口径见 README 的 ZCode 章节）在外部**没有任何可看的证据**
           * —— 「先探后取到底生效没有」只能靠猜。
           *
           * ⚠ 取 logger 用可选链 `?.info?.()`：与同文件既有防御写法一致
           * （`makeReadImageRequest` 的降级告警、`refreshAllCredentials` 的批量续期告警
           * 都是 `ctx.logger?.warn?.(...)`）。宿主没给 logger 时**静默**，
           * 绝不能在推理路径上抛错。
           */
          log: (message: string) => {
            ctx.logger?.info?.(message)
          },
          /**
           * ⚠ **图片字节桥接** —— 这是图片能真正发出去的关键。
           *
           * DSH 的图片块只带 `attachment:{attachmentId}`，真正拿字节要经附件服务。
           * 缺了这两项，`serializeMessages` 拿到**空映射**，图片会退化成
           * `[image unavailable]` 占位符 —— 实测症状是模型回
           * 「我在当前对话中没有收到任何图片」。
           *
           * ⚠ 与其余 provider 同款约定（十余处一致）：
           *   - `readImage`：拿原始字节（内联为 data URL）
           *   - `readImageRequest`：拿**按预算缩放后**的字节；**不可用时返回
           *     `undefined`**（不抛错），适配器据此回退原图
           */
          readImage: host.readImage,
          // 图片请求版本（缩放）桥接：ZCode 免费通道的请求体没有实测硬上限，
          // 但 base64 后的截图很大（2560×1600 各约 3.9 MB），两张就接近常见网关
          // 的 10MB 门槛 —— 与 raccoon 的同因（issue !IKITT9 那一族）。
          readImageRequest: host.readImageRequest,
          // 模型目录用静态白名单（实测可用的两个）—— 上游模型池含
          // 实测返回空响应的两条（GLM-5-Turbo / GLM-5.2），故不枚举远端。
          fetchRemoteModels: () => zcode.fetchRemoteModelsOnly(),
          accountPool: pool,
          product: ZCODE,
          // 就绪判据 = 有可用凭据（插件自存的）。
          isReady: async () => (await zcode.current()) !== undefined,
          /**
           * 额度用尽 / 无权益时，适配器据此**标记失败的账号并切换**。
           *
           * 回调的是「本次实际使用的账号」（理由见 `activeZcodeAccountId` 的注释）——
           * 不要改成 `pool.getAvailableAccount(...)` 之类「再问一次池」的实现。
           */
          currentAccountId: () => activeZcodeAccountId.get(ZCODE.id),
      })
      return zcodeAdapter
    },
    refreshAll: async (target) => {
      await (zcodeAuth as unknown as ZcodeChannelAuth | undefined)?.refreshAll(target)
    },
    dispose: () => {
      // captcha 常驻浏览器必须显式关掉（否则进程退出后留下 chromium 子进程）。
      zcodeAdapter?.stop()
    },
  }
}
