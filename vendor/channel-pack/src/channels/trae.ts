/**
 * TRAE（字节 TRAE IDE）渠道的装配描述。
 *
 * 本文件是 `index.ts` 中原 TRAE 装配块的**原样搬运**：options 内容与注释
 * 逐字保留，只把宿主依赖（账号池、图片桥接、全限流报错、网络出口）改成注入。
 *
 * @module channels/trae
 */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { TraeAuth } from '../trae-auth.js'
import { registerTraeLlm } from '../trae-adapter.js'
import { TRAE } from '../trae-product.js'
import type { TraeCredential, TraeRemoteModel } from '../trae.js'
import { TraeAccountSelector, TraeFailureLedger } from '../trae-selection.js'
import { fetchTraeCreditBalance } from '../trae-credits.js'
import type { AccountPool } from '../account-pool.js'
import type { ChannelAuthInstance, ChannelHost, ChannelSpec } from '../channel-registry.js'
import { reportLedgerAccount } from '../token-ledger.js'

/** TRAE 的 Auth 在注册表最小接口之外的额外能力。 */
export interface TraeChannelAuth extends ChannelAuthInstance {
  refreshAccountCredential(ref: string, pool: AccountPool, accountId: string): Promise<void>
  refresh(): Promise<void>
  fetchModels(pool?: AccountPool): Promise<TraeRemoteModel[]>
  refreshAll(pool: AccountPool): Promise<void>
  repairAccountNicknames(pool: AccountPool): Promise<string[]>
}

/** 装配期需要、但不属于 `ChannelHost` 的依赖。 */
export interface TraeChannelDeps {
  readonly pool: AccountPool
  /** 渠道网络出口（用户配了代理时**必须**用它，否则静默退回全局 fetch）。 */
  readonly fetcher: typeof fetch
}

export function createTraeChannel(deps: TraeChannelDeps): ChannelSpec {
  const { pool, fetcher } = deps
  let authContext: Context = undefined as unknown as Context
  let auth: TraeAuth | undefined
  let traeAuth: TraeChannelAuth | undefined
  let adapter: ReturnType<typeof registerTraeLlm> | undefined

  /** 按凭据 ref 解析 TRAE 凭据（供选号器与兜底路径共用）。 */
  const resolveTraeCredentialByRef = async (refName: string): Promise<TraeCredential | undefined> => {
    const resolved = await authContext.credentials.resolve(credentialRef(refName))
    if (!resolved) return undefined
    try {
      return JSON.parse(resolved.value) as TraeCredential
    } catch {
      return undefined
    }
  }

  /**
   * TRAE 的**轮转选号器**（多号分流）。
   *
   * 与 Loomy/Buddy 的余额分档不同：TRAE 的积分是**一次性、有到期日**的包，
   * 且没有批量余额端点（N 个号 = N 次 HTTP）。故这里只在**付费模型**上查余额
   * （`creditsRate === 0` 的免费模型直接走轮转，零额外请求），查到的到期时间
   * 只用于「快作废的号插队」，平时严格等权轮转 —— 详见 `trae-selection.ts`。
   */
  const traeSelector = new TraeAccountSelector({
    resolveCredential: resolveTraeCredentialByRef,
    // ⚠️ 必须用 channel 的网络出口（用户配了代理而 trae 直连不通时，
    // 这里不注入就会绕过代理、静默退回 `globalThis.fetch`）。
    fetchBalance: credential => fetchTraeCreditBalance(credential, TRAE, fetcher),
  })

  /** TRAE 的连续失败账本（3 连败才冷却，指数增长封顶 30 分钟）。 */
  const traeFailureLedger = new TraeFailureLedger({
    updateModelRateLimit: (accountId, modelId, resetAtMs) =>
      pool.updateModelRateLimit(accountId, modelId, resetAtMs),
  })

  /**
   * 按 TRAE 的轮转 / 快作废插队策略选一个账号。
   *
   * 抽成局部函数而非内联两遍：首发（`resolveCredential`）与换号（`nextAccount`）
   * 必须走**同一套**策略 —— 两处若各写一遍，「平时轮转」就只在其中一条路径生效。
   *
   * @param modelId - 本轮模型；空串表示「未知模型」（`refresh` 等无模型上下文的场合）。
   * @param tried - 本次请求已失败的账号 id，实现会跳过它们。
   * @returns 选中的账号与凭据；池为空或全部不可用时 `undefined`。
   */
  async function pickTraeSelection(
    modelId: string,
    tried: ReadonlySet<string> = new Set<string>(),
  ): Promise<{ accountId: string; credential: TraeCredential } | undefined> {
    const candidates = pool.listAccountsByProvider(TRAE.id)
      // 与池内其余选号路径同款：停用账号永不参与。
      .filter(entry => entry.enabled)
      .filter(entry => !tried.has(entry.id))
      // 冷却中的账号跳过（冷却写进 `modelRateLimits`，见 `TraeFailureLedger`）。
      .filter((entry) => {
        if (modelId.length === 0) return true
        const resetAt = entry.modelRateLimits?.[modelId]
        return resetAt === undefined || resetAt === 0 || Date.now() >= resetAt
      })
      .map(entry => ({ id: entry.id, credentialRef: entry.credentialRef }))
    if (candidates.length === 0) {
      // 全被「冷却中」排除 ≠ 没有账号：此时用户该做的是等解禁，不是重新登录。
      // 让池把「最近一个什么时候解禁」翻成人话，避免落进下面的通用兜底。
      hostRef.throwIfAllAccountsRateLimited(TRAE, modelId)
      return undefined
    }
    // 免费模型不查余额（`creditsRate === 0`）；查不到远端目录时按付费处理。
    const freeModel = modelId.length > 0 && await (adapter as ReturnType<typeof registerTraeLlm>).isFreeModel(modelId)
    const picked = await traeSelector.select(modelId, candidates, freeModel)
    if (picked === undefined) {
      // 候选都在、但凭据一个都解析不出来 → 也按「不可用」报，别静默退到默认凭据。
      hostRef.throwIfAllAccountsRateLimited(TRAE, modelId)
      return undefined
    }
    // Token 账本（第 2 期）：回报「本笔请求解析出的账号」。
    reportLedgerAccount(TRAE.id, picked.accountId)
    return picked
  }

  // `pickTraeSelection` 被 `registerLlm` 前后的两处调用共享，host 也只能在
  // registerLlm 的参数里拿到 —— 故缓存成一个模块内引用（闭包在装配后才执行）。
  let hostRef: ChannelHost = undefined as unknown as ChannelHost

  return {
    id: TRAE.id,
    namespace: 'llm-trae',
    createAuth: (ctx) => {
      authContext = ctx
      auth = new TraeAuth(ctx)
      traeAuth = auth as unknown as TraeChannelAuth
      return auth as unknown as ChannelAuthInstance
    },
    registerLlm: (ctx: Context, host: ChannelHost) => {
      hostRef = host
      const trae = auth as unknown as TraeChannelAuth
      adapter = registerTraeLlm(ctx, {
        credentialRef: credentialRef(TRAE.defaultCredentialRef),
        resolveCredential: async (modelId?: string) => {
          // ⚠️ `modelId` 必须透传：限流是**按模型**记的（`modelRateLimits[model]`），
          // 传空串会让 `getAvailableAccount` 的限流过滤整体短路
          //（`if (modelId.length === 0) return true`）→ 被标记限流的账号仍被选中，
          // 换号形同虚设（用户报障「没有切换」的根因之一）。
          //
          // 走轮转选号器（与 `nextAccount` 同一个）：首发的选号也必须是轮转的，
          // 否则「平时等权轮转」只在换号时才生效，首发仍钉死在第一个号。
          const picked = await pickTraeSelection(modelId ?? '')
          if (picked !== undefined) return picked.credential
          const resolved = await authContext.credentials.resolve(credentialRef(TRAE.defaultCredentialRef))
          if (!resolved) return undefined
          try {
            return JSON.parse(resolved.value) as TraeCredential
          } catch {
            return undefined
          }
        },
        refresh: async () => {
          const available = await pool.getAvailableAccount(TRAE.id, '')
          if (available) await trae.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id)
          else await trae.refresh()
        },
        fetchRemoteModels: () => trae.fetchModels(pool),
        // 图片字节桥接：TRAE 上游**支持图片**（见 Issue #IKHDKC 的实测记录），
        // 但模态按模型判定（远端 `display_config.multimodal`），故这里只负责读字节。
        readImage: host.readImage,
        accountPool: pool,
        nextAccount: async (modelId, tried) => {
          const picked = await pickTraeSelection(modelId, tried)
          if (picked === undefined) return undefined
          return picked
        },
        failureLedger: traeFailureLedger,
        product: TRAE,
      })
      return adapter
    },
    // 一次性修复**老 TRAE 账号**的展示名（与 Raccoon 同类，同因）：
    // 服务端 ScreenName 是**按 uid 自动生成的默认名**（`用户26815487395`），
    // 多账号无法区分；`GetUserInfo` 的 `NonPlainTextMobile`（脱敏手机号）可区分。
    // 光改代码只影响新登录的账号，故这里主动补一次。
    //
    // ⚠️ 幂等 + 失败不阻塞启动（`repairAccountNicknames` 内部逐账号 catch）。
    afterMount: (ctx) => {
      void (traeAuth as TraeChannelAuth).repairAccountNicknames(pool).then((repaired) => {
        if (repaired.length > 0) {
          ctx.logger.info(
            '[channel-pack] 已修正 ' + repaired.length + ' 个 TRAE 账号的显示名（改用脱敏手机号以便区分）：' + repaired.join(', '),
          )
        }
      }).catch((error: unknown) => {
        ctx.logger.warn('[channel-pack] 修正 TRAE 账号显示名失败：' + String(error))
      })
    },
    // 定时续期：必须刷池内账号（`TRAE_ACCESS_TOKEN` 从未被写入过）。
    refreshAll: async (target) => {
      await auth?.refreshAll(target)
    },
  }
}
