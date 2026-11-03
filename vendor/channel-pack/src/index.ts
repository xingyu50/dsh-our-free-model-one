import type { Context } from '@deepseek-ai/cordis'
import { LlmError } from '@deepseek-ai/dsh-llm'
import Schema from '@deepseek-ai/schemastery'
import { AccountPool, allAccountsRateLimitedForModel } from './account-pool.js'
import { hasLegacyNamespaceRegistration, settingsOf, suppressAutoSettingsPage } from './settings-compat.js'
import type { ImageRequestTarget } from './image-budget.js'
import { registerChannelPackRpc, type ChannelPackAuths } from './channel-pack-rpc.js'
import { mountChannels, stopChannels } from './channel-registry.js'
import type { ChannelHost, ChannelSpec } from './channel-registry.js'
import { createCodeArtsChannel } from './channels/codearts.js'
import { createBuddyChannel, createWorkBuddyChannel } from './channels/buddy.js'
import { createLobsteraiChannel } from './channels/lobsterai.js'
import { createQoderChannel, createQoderCnChannel } from './channels/qoder.js'
import { createTraeChannel } from './channels/trae.js'
import { createClineChannel } from './channels/cline.js'
import { createLoomyChannel } from './channels/loomy.js'
import { createRaccoonChannel } from './channels/raccoon.js'
import { createMinimaxChannel } from './channels/minimax.js'
import { createGeminiChannel } from './channels/gemini.js'
import { createZcodeChannel } from './channels/zcode.js'
import { createOpencodeChannel } from './channels/opencode.js'
import { mountOpenAiGateway } from './openai-gateway/index.js'
import { installLoopResume } from './loop-recovery.js'
import { attachTokenLedgerStore } from './token-ledger.js'
import { createTokenLedgerStore } from './token-ledger-store.js'
import { configureDeadModelStore, withDeadModelPruning } from './dead-model-store.js'
import { createChannelFetch, type ChannelOutlet } from './channel-fetch.js'
export { createChannelFetch, parseWindowsProxy, channelProxyBypassed } from './channel-fetch.js'

export const name = 'channel-pack'
// `connection` 刻意不列入静态 inject：它只由 Web bundle（dsh-client-connection）
// 提供，headless/CLI profile 里并不存在。静态 inject 会让本插件在那些 profile
// 里永久 pending，进而让整个 profile 以
// "plugin tree failed to load: 1 entry did not activate" 启动失败
// —— chicheng-cron 的 skill/agent 任务正是通过 `dsh --profile headless` 运行的，
// 会因此全部 exit 1。Channel Pack 的 RPC 端点在 Web 下通过 apply 内的可选注入挂载，
// 其余 profile 只是不注册该端点。
export const inject = ['credentials', 'commands', 'llm']

/**
 * 插件 Config schema。
 *
 * ⚠️ **DSH 0.1.7-rc.1 起，settings 表单的命名空间就是 profile 条目 id**
 * （本插件的条目 id 是 `channel-pack`），且只投影本条目 Config 中标记了
 * `.volatile()` 的字段。因此这里保留一个 `providers` 映射：
 * - **历史**：它曾是各 provider 用 `registerConfigurableProviders({ settingsNs })`
 *   声明时的落地位置，模型设置页据此把它们判定为「已配置」（判据见
 *   `dsh-client-ui-settings-models` 的 `configured`）。**2026-10-01 起本插件不再
 *   声明可配置 provider**（见 `llm-register-compat.ts` 模块头），该映射因此没有
 *   消费者，保留它只为不改变 `settings.describe()` 的既有形状；
 * - 本插件的凭据与账号管理**不**走这里（那是 Channel Pack 的账号池 +
 *   `ctx.credentials`），故该字段只承接一个宽松映射，不参与业务读取。
 *
 * 必须是 schemastery schema：`SettingsForms.describe()` 会对每个注册项调用
 * `schema.toJSON()`，传入裸函数（`(value) => ...`）会让它抛
 * `TypeError: ... .toJSON is not a function`，进而使所有依赖 settings 的界面
 * （模型设置页、sidebar 的 settings.get/shell.get）全部失败。
 */
export const Config = Schema.object({
  providers: Schema.dict(Schema.any()).default({}).volatile(),
})

/**
 * 注册 provider 配置 namespace（**仅老契约需要**）。
 *
 * ⚠️ **2026-10-01 起各 provider 不再声明为可配置 provider**（`settingsNamespaceFor`
 * 因此没有调用方），模型设置页不再有这些 namespace 的消费者 —— 这份注册此后只影响
 * ≤0.1.6 的老契约 profile，属遗留行为，本次未一并删除。
 */
function registerProviderSettings(ctx: Context, ...namespaces: string[]): void {
  const settings = settingsOf(ctx)
  if (!hasLegacyNamespaceRegistration(settings) || settings?.register === undefined) return
  for (const ns of namespaces) {
    try {
      settings.register(ns, Config)
    } catch (error) {
      ctx.logger.warn(`[channel-pack] settings namespace "${ns}" 注册失败: ${String(error)}`)
    }
  }
  // 回读确认：模型设置页要求 settingsNs 真实存在于 describe() 中。
  // 注意：describe() 会遍历所有已注册 namespace 并调用各自 schema 的
  // toJSON()/redactSecrets()，任一注册项的 schema 不合规都会让整条调用抛错。
  // 因此这里必须把异常打出来，而不是静默吞掉。
  try {
    const descriptors = settings.describe?.({ redactSecrets: true }) ?? []
    const registered = descriptors.map(v => v.ns)
    const missing = namespaces.filter(ns => !registered.includes(ns))
    if (missing.length > 0) {
      ctx.logger.warn(`[channel-pack] provider namespace 未生效: ${missing.join(', ')}`)
    }
    ctx.logger.info(`[channel-pack] settings.describe ok, namespaces: ${registered.join(', ')}`)
  } catch (error) {
    ctx.logger.error(
      `[channel-pack] settings.describe 失败（将导致模型设置页/sidebar settings API 不可用）: `
      + `${error instanceof Error ? error.stack ?? error.message : String(error)}`,
    )
  }
}

/**
 * 图片附件桥接：把持久化图片读成原始字节供适配器内联。
 */
export function makeReadImage(ctx: Context) {
  return async (attachment: unknown): Promise<{ data: Uint8Array; mediaType: string }> => {
    const attachments = ctx.get('attachments') as
      { readImage?: (ref: never) => Promise<{ data: Uint8Array; ref: { mediaType: string } }> } | undefined
    if (attachments?.readImage === undefined) {
      throw new Error(
        'channel-pack: 附件服务（attachments）不可用，无法把图片内联进请求；'
        + '请确认当前 profile 已装载 @deepseek-ai/dsh-attachment-local。',
      )
    }
    const stored = await attachments.readImage(attachment as never)
    return { data: stored.data, mediaType: stored.ref.mediaType }
  }
}

/**
 * 图片「请求版本」桥接（issue !IKITT9）。
 *
 * 走 `ctx.attachments.readImageRequest(ref, target)`：由附件服务按目标尺寸与
 * 字节目标产出**确定性、可缓存**的缩放版本（alpha 走 WebP、不透明走 JPEG、
 * 85/75/60 质量阶梯），适配器只负责选目标。
 *
 * ⚠️ **任何不可用都返回 `undefined`，绝不抛错**，调用方据此回退原图。三种
 * 真实成因都必须容忍，否则「加上缩放」本身会变成新的故障源：
 *
 * 1. 宿主 profile 没装附件服务，或该版本没有 `readImageRequest`（老契约）；
 * 2. 附件后端明确拒绝投影（`ATTACHMENT_PROJECTION_UNSUPPORTED`）；
 * 3. 派生过程中的其它错误（缓存不可写、字节校验失败…）。
 *
 * 回退方向是刻意选 conservative 的一侧：宁可发一张大图（顶多触发网关的
 * 图片 token 上限），也不能因为「想缩图」而把一次本来能成功的请求打死。
 */
export function makeReadImageRequest(ctx: Context) {
  return async (
    attachment: unknown,
    target: ImageRequestTarget,
  ): Promise<{ data: Uint8Array; mediaType: string } | undefined> => {
    const attachments = ctx.get('attachments') as {
      readImageRequest?: (
        ref: never,
        requestTarget: never,
      ) => Promise<{ data: Uint8Array; mediaType?: string; attachment?: { mediaType?: string } }>
    } | undefined
    if (attachments?.readImageRequest === undefined) return undefined
    try {
      const projected = await attachments.readImageRequest(attachment as never, target as never)
      const mediaType = projected.mediaType ?? projected.attachment?.mediaType
      if (mediaType === undefined) return undefined
      return { data: projected.data, mediaType }
    } catch (error) {
      // 只记日志、随后回退原图：缩放是优化，不是请求的前置条件。
      ctx.logger?.warn?.(
        '[channel-pack] 图片请求版本派生失败，回退原图：'
        + `${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    }
  }
}

export function apply(ctx: Context, config: { disableOpencode?: boolean; outlet?: ChannelOutlet } = {}): void {
  const network = createChannelFetch({ outlet: config.outlet })
  ctx.effect(() => () => { void network.close() })
  // 本插件自带 Channel Pack 设置页，关闭 0.1.7 起由 Config schema 反渲染的自动表单
  // （老契约没有 configure()，静默跳过）。
  suppressAutoSettingsPage(ctx)

  // provider 配置命名空间的注册**只在老契约（≤0.1.6）下执行**：

  // Qoder（qoder / qodercn）、TRAE（trae）、Cline（cline）、Loomy（loomy）、
  // Raccoon（raccoon）、MiniMax（minimax）与 Zcode（zcode）。
  //
  // 0.1.7-rc.1 起 settings 换成 SettingsForms（无 register），命名空间只能是
  // profile 条目 id，故这里不做任何注册。
  //
  // ⚠️ 2026-10-01 起各 provider 已**不再**声明为可配置 provider，故这批 namespace
  // 在模型设置页上已无消费者（详见该函数头的说明）。
  //
  // ⚠️ 具体的 namespace 清单现在**由注册表派生**（写在下面装配之后，
  // 各渠道在 `channels/<id>.ts` 里自报自己的 namespace）。
  const pool = new AccountPool(ctx)

  // 「已失效模型」剔除：注入 ctx 只为把日志接进 DSH logger 并复用同一份 home
  // 解析。必须在任何 `registerXxxLlm` 之前调用 —— 各适配器经
  // `registerAdapterIdempotent` 注册时就会包装上剔除逻辑（见该函数注释）。
  configureDeadModelStore(ctx)

  // ===== Token 账本持久化（第 2 期 · 日聚合落盘）=====
  //
  // ⚠️ 账本本体是模块级单例（`token-ledger.ts`），没有 ctx 可拿 —— 故在启动时
  // 把后端挂进去（`attachTokenLedgerStore`）。挂载发生在**任何适配器注册之前**：
  // 启动早期就有模型请求（标题生成等）时，落盘已在位。
  //
  // ⚠️ 后端契约是**绝不抛错**（`recordTokenUsage` 的调用点在推理关键路径上，
  // 见其函数注释），`FileLedgerStore` 内部已按此实现。
  //
  // ⚠️ dispose **必须用返回的 disposer**（不能无条件 `attach(undefined)`）：
  // 插件 fiber 重启时新 apply 与旧 fiber 的异步 dispose **交错执行**
  //（本仓库已确证的事故，见 `llm-register-compat.ts` 模块头），无条件摘会把
  // **新实例刚挂上**的后端摘空 ⇒ 落盘停摆且历史视图恒为空。disposer 自带所有权
  // 校验（只摘自己的），并顺带 `flush` 当前这份数据。
  const tokenLedgerStore = createTokenLedgerStore(ctx)
  const detachTokenLedger = attachTokenLedgerStore(tokenLedgerStore)
  ctx.effect(() => () => {
    try {
      tokenLedgerStore.flush()
    } finally {
      detachTokenLedger()
    }
  }, 'token-ledger-persistence')

  /**
   * 在「候选为空、即将退到单凭据 ref」这一刻，先证明失败原因是不是**限流**。
   *
   * ## 它修的是什么（真实缺陷，2026-10-03）
   *
   * 即：**凭据问题被误报成「没登录」，而真实原因是限流**。用户据此去重新
   * 登录，方向完全错。这与本仓库已记录的同类病根一致 —— 用默认归类代替了
   * 对业务语义的判断（qoder 的 `110` 被误归 `SERVER`、`10605` 排队被漏判）。
   *
   * ⚠️ 这里**只改错误语义，不改可用性**：没有账号可用就是没有，压缩该失败
   * 仍然失败；修的是「用户看到的原因」。绝不静默换模型、也绝不绕过限流标记。
   */
  const throwIfAllAccountsRateLimited = (
    product: { id: string; displayName: string },
    modelId?: string,
  ): void => {
    const limited = allAccountsRateLimitedForModel(
      // 只统计**启用**账号：停用账号本就不参与自动选号，把它们算进来会
      // 让「有一个号被停用」的普通情况被误报成「全部限流」。
      pool.listAccountsByProvider(product.id).filter(a => a.enabled),
      modelId ?? '',
    )
    if (limited === undefined) return
    throw new LlmError(
      `${product.displayName}：模型 ${modelId} 的可用账号均在限流中，`
      + `最近一个将于 ${new Date(limited.resetAtMs).toLocaleString('zh-CN')} 解禁。`
      + `可改用其它 provider / 模型，或等待解禁后再试（无需重新登录）。`,
      'QUOTA_EXCEEDED',
    )
  }

  // ===== 渠道装配（全部由注册表驱动）=====
  //
  // 十三家渠道的装配细节各自住在 `channels/<id>.ts`，本文件只负责：
  // 1. 按顺序给出表（顺序即注册顺序，`model.list` 与设置页按它排）；
  // 2. 提供注册表要的宿主侧桥接（图片字节、全限流报错）；
  // 3. 由装配结果**派生**下面那三张表（模型目录、批量续期、RPC 的 auths）。
  //
  // ⚠️ 派生而不是手写，是这次重构的要点：早先「新增渠道」要同时改装配块、
  // settings namespace 列表、refreshTargets 与 modelAdapters 四处，漏一处就出
  // 「Gemini 漏了这行定时器不武装」这类静默缺陷（见 `channel-registry.ts` 模块头）。
  const host: ChannelHost = {
    readImage: makeReadImage(ctx),
    readImageRequest: makeReadImageRequest(ctx),
    throwIfAllAccountsRateLimited,
  }
  const specs: ChannelSpec[] = [
    createCodeArtsChannel({ pool }),
    createBuddyChannel({ pool }),
    createWorkBuddyChannel({ pool }),
    createLobsteraiChannel({ pool }),
    createQoderChannel({ pool }),
    createQoderCnChannel({ pool }),
    // ⚠️ TRAE / Cline / Gemini 走渠道自己的网络出口（用户配了代理时必须用它，
    // 否则静默退回全局 fetch）。其余渠道用全局 fetch。
    createTraeChannel({ pool, fetcher: network.fetch }),
    createClineChannel({ pool, fetcher: network.fetch }),
    createLoomyChannel({ pool }),
    createRaccoonChannel({ pool }),
    createMinimaxChannel({ pool }),
    // ⚠️ 顺序沿用重构前的**装配**顺序（gemini 在 zcode 之前，见重构前 index.ts
    // :1288 与 :1405）：llm provider 的注册顺序会体现在目录/选择器的排列上，
    // 故这里以装配顺序为准。续期目标表由同一张表派生，因此 zcode 与 gemini 的
    // 续期先后与重构前相反 —— 两者互不依赖且各自 try/catch，仅影响日志行序。
    createGeminiChannel({ pool, fetcher: network.fetch }),
    createZcodeChannel({ pool }),
    // opencode 的条件装配在这里判：注册表只按给定的表装，不认识这条开关。
    ...(config.disableOpencode === true ? [] : [createOpencodeChannel({ pool })]),
  ]
  // 老契约的 settings namespace：从**表**收集（缺 namespace 的渠道 opencode
  // 本来就不在其中），并且**在装配之前**注册 —— 与重构前逐行一致：早先这
  // 一行排在所有 `new XxxAuth(ctx)` 之前，Auth 构造函数里读 settings 的渠道
  // 不该看到「自己还没注册」的中间状态。
  const namespaces = specs
    .map(spec => spec.namespace)
    .filter((namespace): namespace is string => namespace !== undefined)
  registerProviderSettings(ctx, ...namespaces)

  const channelRuntimes = mountChannels(ctx, host, specs)

  // ===== 多账号静默续期调度 =====
  // 替代原有的单账号 scheduleRefresh()，使用 refreshAll() 遍历所有账号续期
  const REFRESH_INTERVAL_MS = 30 * 60 * 1000  // 每 30 分钟检查一次

  /**
   * 当前启用的 provider 实例的续期入口（不包括已退役的渠道）。
   *
   * 收成一张表是为了让「失败必须留日志」这条规则**只写一遍** —— 原先这里是
   * 十个空 catch（注释写着「静默」），把 provider 内部的告警与异常一起吞掉，
   * 「凭据一直刷不动」在日志里完全无痕（issue !IKIRTT 的可观测性条目）。
   *
   * ⚠️ 表由注册表派生：新增渠道只要在 `channels/<id>.ts` 里给 `refreshAll`，
   * 定时器自动带上它 —— 「漏了这行定时器不武装」的缺陷在结构上不再可能。
   * 各家内部语义不同（loomy 只探已过期、raccoon/minimax 按 refreshable、
   * zcode 只回写、gemini 走 Google OAuth 轮换），差异留在各自 spec 里。
   */
  const refreshTargets: ReadonlyArray<readonly [string, (pool: AccountPool) => Promise<void>]> = channelRuntimes
    .flatMap(runtime => runtime.spec.refreshAll === undefined
      ? []
      : [[runtime.spec.id, runtime.spec.refreshAll] as const])

  async function refreshAllCredentials(): Promise<void> {
    for (const [tag, refreshAll] of refreshTargets) {
      try {
        await refreshAll(pool)
      } catch (error) {
        // 单个 provider 抛错不得中断其余九个（各 refreshAll 内部本就逐账号
        // try，能冒到这里的已是「整批失败」级别的异常）。
        ctx.logger?.warn?.(
          `[channel-pack] ${tag} 批量续期失败：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }
  // 启动时只要账号池非空，就安排首轮续期 + 定期续期。
  //
  // ⚠️ 判据是「**池里有账号**」，不是「有 `refreshable` 的账号」（2026-10-02 修订）。
  // 原先写成 `accounts.some(a => a.refreshable)`，于是这个定时器**是否武装**
  // 取决于那批可能已经被误标成 false 的布尔 —— 而它存在的意义恰恰是去修正误标。
  // 本次事故实测：36 条账号只剩 3 条 `true`（raccoon / minimax / cline 各一），
  // 且日志里一个字都不会有。各家 `refreshAll` 内部本来就按凭据材料 / 是否过期
  // 过滤（`loomy` 只探已过期的、其余看 `refreshableOf(credential)`），
  // 所以放宽这里的判据最多多一次本地遍历，不会白发请求。
  //
  // ⚠️ 仍然**不看 `enabled`**（AGENTS.md 既有铁律）：停用只影响自动选号，
  // 不该让凭据停止续期。早期写成 `a.refreshable && a.enabled`，于是
  // 「所有账号都被停用」时续期定时器根本不启动，凭据一路烂到 refresh_token 失效。
  //
  // ⚠️ **必须立刻先跑一轮**（issue !IKIRTT 的主缺陷）：早先这里只有
  // `setInterval`，第一次处理要等满一个周期。短寿命 provider（cline 1 小时、
  // 于是重启后**最长 30 分钟**一直显示「已过期」、积分行一直 401。
  // 现在这一轮与 lead-time 过滤配合（`src/expiry-sync.ts` 的 `shouldRefreshNow`），
  // 只对「距过期不足 1 小时」的账号发续期请求，其余只做一次本地对账 ——
  // 既补上了首轮，又不会在启动时打出几十个无谓请求。
  pool.listAllAccounts().then(accounts => {
    if (accounts.length === 0) return
    void refreshAllCredentials()
    const refreshTimer = setInterval(() => void refreshAllCredentials(), REFRESH_INTERVAL_MS)
    refreshTimer.unref?.()
    ctx.effect(() => () => {
      clearInterval(refreshTimer)
      // ⚠️ 十五处 `xxx.stop()` 曾在这里逐行重复了两遍（本清单与下面的 legacy 清单），
      // 加渠道忘记补一行就是「卸载后留孤儿」。现在只剩这一处：auth.stop()、
      // 渠道的 dispose（captcha 浏览器、签名缓存落盘）都由 `stopChannels` 统一做。
      stopChannels(channelRuntimes)
    }, 'channel-pack: multi-account refresh scheduler')
  }).catch((error: unknown) => {
    // ⚠️ 原来这个 `.then()` **没有** `.catch()`：`listAllAccounts()` 一旦 reject
    // （存储层异常），续期定时器就**永远不武装**，且日志里一个字都没有 ——
    // 那时上面的「最长 30 分钟」会恶化成「永不自愈」。
    ctx.logger?.warn?.(
      `[channel-pack] 多账号续期调度器启动失败（本次会话不会自动续期）：`
      + `${error instanceof Error ? error.message : String(error)}`,
    )
  })

  // 保留旧的 stop scheduler（兼容旧命令）：装配结果已由上面的 effect 回收，
  // 这里只保留 effect 的挂载位置本身（停用路径幂等，`stopChannels` 内部有
  // WeakSet 去重）。
  ctx.effect(() => () => { stopChannels(channelRuntimes) }, 'channel-pack.scheduler (legacy)')

  // ===== Channel Pack RPC 注册 =====
  // provider → 适配器实例：Channel Pack「显示列表」需要 `listAllModels()`（不受用户
  // 黑名单影响的全量目录，带最终展示名/倍率）。DSH 的 `ctx.llm` 只保证
  // `listModels`，不透传自定义方法，故这里显式把实例传下去。
  //
  // ⚠️⚠️ **必须走 `withDeadModelPruning`，不能直接用 `registerXxxLlm` 的返回值**
  // （致命缺陷，2026-10-06 复审 !66 实测）：那些函数返回的是 `new XxxAdapter(...)`
  // —— **原始实例**，而 `registerAdapterIdempotent` 只把**代理**注册进了 `ctx.llm`。
  // 于是 `channel-pack-rpc` 的 `model.list` 先 `await llm.listModels()`（走代理，已剔除），
  // 紧接着又用本表的 `listAllModels()` **覆盖**成全量目录（走原始，**未剔除**）⇒
  // 已失效模型被加回设置页，PR 想修的「用户仍看到下架模型」原问题**完全没修到**。
  //
  // 这里复用与注册**同一个**包装函数，确保两条路径的可见性一致。
  // ⚠️ 包装失败**不阻断启动**：回退到原始实例即可（它只是显示层的收敛）。
  const pruned = <T extends object>(provider: string, adapter: T): T => {
    try {
      return withDeadModelPruning([provider], adapter)
    } catch (error) {
      ctx.logger.warn(`[channel-pack] ${provider} 的失效模型剔除包装失败，使用原适配器: ${String(error)}`)
      return adapter
    }
  }
  // 表由装配结果派生：⚠️ 键是**渠道 id**（不是 auths 键 —— RPC 查目录用的是
  // `modelAdapters[req.provider]`，而 `provider` 一直是渠道 id），值是注册后
  // 返回的适配器实例。
  const modelAdapters: Record<string, { listAllModels(): readonly { id: string; name: string }[] }> = {}
  for (const runtime of channelRuntimes) {
    modelAdapters[runtime.spec.id] = pruned(runtime.spec.id, runtime.adapter)
  }

  // 按 id 传入而不是按位置 —— 位置传参曾因少传/插队错位复发 6 次
  //（见 channel-pack-rpc.ts 的 ChannelPackAuths 注释）。
  //
  // ⚠️ 用**完整对象字面量**而不是 `Object.fromEntries(…) as unknown as ChannelPackAuths`：
  // 后者会把「漏一门渠道」从编译期错误降级成运行期才暴露的分派失败，恰好把
  // `ChannelPackAuths` 注释里「漏传一个就是缺键」那条规则废掉。这里逐个写键，
  // 少写一个 TS 直接报缺属性；值仍按装配结果取，取不到就是装配表里没有那条 spec。
  const authOf = <K extends keyof ChannelPackAuths>(key: K): ChannelPackAuths[K] => {
    const found = channelRuntimes.find(runtime => (runtime.spec.rpcAuthKey ?? runtime.spec.id) === key)
    if (found === undefined) {
      throw new Error(`[channel-pack] 装配表里没有 rpcAuthKey 为 \`${key}\` 的渠道（auths 表与 specs 表脱节）`)
    }
    // 装配表只知道 `ChannelAuthInstance`（最小接口），具体 Auth 类型由各 spec 造；
    // 这里是把「已按 id 对号入座」的结果交回给 RPC 的固定形状。
    return found.auth as unknown as ChannelPackAuths[K]
  }
  const auths: ChannelPackAuths = {
    codearts: authOf('codearts'),
    buddy: authOf('buddy'),
    workbuddy: authOf('workbuddy'),
    lobsterai: authOf('lobsterai'),
    qoder: authOf('qoder'),
    qoderCn: authOf('qoderCn'),
    trae: authOf('trae'),
    cline: authOf('cline'),
    loomy: authOf('loomy'),
    raccoon: authOf('raccoon'),
    minimax: authOf('minimax'),
    zcode: authOf('zcode'),
    gemini: authOf('gemini'),
  }
  registerChannelPackRpc(ctx, pool, auths, modelAdapters, {
    ...config,
  })
  // 网关是旁路功能：这里传 `pool` 只为读设置页里的开关，其内部任何失败都已
  // 自行降级为日志，绝不会让插件 apply() 失败。
  mountOpenAiGateway(ctx, pool)
  // 思考死循环被中止后的**自动续跑**：把此前必须由用户手打「继续」的那一步
  // 自动化（真实报障 2026-10-04，见 `loop-recovery.ts` 模块头）。
  // ⚠️ 它依赖 `agents` 服务，故内部用 `ctx.inject(['agents'], …)` 挂载：
  // 该服务缺席的 profile 里本功能整体不生效，不会让插件永久 pending。
  installLoopResume(ctx)
  ctx.provide('accountPool', pool)
}
