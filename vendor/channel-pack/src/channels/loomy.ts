/**
 * Loomy（讯飞办公助手）渠道的装配描述。
 *
 * 本文件是 `index.ts` 中原 Loomy 装配块的**原样搬运**：options 内容与注释
 * 逐字保留，只把宿主依赖（账号池、图片桥接、全限流报错）改成注入。
 *
 * @module channels/loomy
 */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LoomyAuth } from '../loomy-auth.js'
import { registerLoomyLlm, parseLoomyRemoteModels } from '../loomy-adapter.js'
import { LOOMY } from '../loomy-product.js'
import type { LoomyCredential } from '../loomy.js'
import { LoomyBalanceSelector } from '../loomy-balance-selector.js'
import type { AccountPool } from '../account-pool.js'
import type { ChannelAuthInstance, ChannelHost, ChannelSpec } from '../channel-registry.js'
import { reportLedgerAccount } from '../token-ledger.js'

/** Loomy 的 Auth 在注册表最小接口之外的额外能力。 */
export interface LoomyChannelAuth extends ChannelAuthInstance {
  refreshAccountCredential(ref: string, pool: AccountPool, accountId: string): Promise<void>
  refresh(): Promise<void>
  refreshAll(pool: AccountPool): Promise<void>
}

/** 装配期需要、但不属于 `ChannelHost` 的依赖。 */
export interface LoomyChannelDeps {
  readonly pool: AccountPool
}

export function createLoomyChannel(deps: LoomyChannelDeps): ChannelSpec {
  const { pool } = deps
  let authContext: Context = undefined as unknown as Context
  let auth: LoomyAuth | undefined

  /**
   * 按凭据 ref 解析 Loomy 凭据（供选号器与兜底路径共用）。
   *
   * 抽成局部函数而非内联两遍：选号器需要它查余额，而解析最终凭据又要用它 ——
   * 两处若各写一遍 JSON 解析，格式一变就会只改一处。
   */
  const resolveLoomyCredentialByRef = async (refName: string): Promise<LoomyCredential | undefined> => {
    const resolved = await authContext.credentials.resolve(credentialRef(refName))
    if (!resolved) return undefined
    try {
      return JSON.parse(resolved.value) as LoomyCredential
    } catch {
      return undefined
    }
  }

  /**
   * Loomy 的**按余额优先选号器**（负载均衡）。
   *
   * ⚠️ **为什么需要它**（真实缺陷）：实测 Loomy 的今日赠送额度（每天 5000）
   * 耗尽后，服务端**继续扣永久积分且不报错** —— 「耗尽」是**静默降级**而非错误。
   * 而本插件既有的「限流 → 换号」只在服务端返回限流错误时触发，
   * 故对 Loomy **完全无效**：会一直烧同一个号（用户报障）。
   *
   * 策略：优先有今日额度的号 → 其次有永久积分的号 → 都无/查不到排最后。
   * 档内保持手动拖拽顺序（详见 `loomy-balance-rank.ts`）。
   */
  const loomyBalanceSelector = new LoomyBalanceSelector({
    product: LOOMY,
    resolveCredential: resolveLoomyCredentialByRef,
  })

  return {
    id: LOOMY.id,
    namespace: 'llm-loomy',
    createAuth: (ctx) => {
      authContext = ctx
      auth = new LoomyAuth(ctx)
      return auth as unknown as ChannelAuthInstance
    },
    registerLlm: (ctx: Context, host: ChannelHost) => {
      const loomy = auth as unknown as LoomyChannelAuth
      return registerLoomyLlm(ctx, {
        credentialRef: credentialRef(LOOMY.defaultCredentialRef),
        /**
         * 解析本轮该用哪个账号的凭据。
         *
         * ⚠️ `modelId` 由适配器传入（见 `LoomyAdapterOptions.resolveCredential`
         * 的签名说明）—— **必须透传给 `getAvailableAccount`**，否则模型级限流
         * 过滤失效（早期实现传空串 `''`，等于「不按模型过滤」）。
         */
        resolveCredential: async (modelId?: string) => {
          // 只从 Loomy 自己的账号池取账号，回退到自己的单凭据 ref，
          // 保证不会串用其它 provider 的凭据。
          // provider 实参用 LOOMY.id 而非字面量 'loomy'：写死字面量在
          // 改名/多产品场景下会静默查不到账号。
          //
          // ⚠️ 先按「模型未受限 + 未停用」筛出候选，**再**按余额分档选号。
          // 余额排序只在这批候选内部进行 —— 即你的要求：
          // 「策略建立在模型没有受限且账户没有被设置为停用的基础上」。
          const candidates = pool
            .listAccountsByProvider(LOOMY.id)
            .filter(a => a.enabled)
            .filter((a) => {
              // 与 `getAvailableAccount` 的限流判据保持一致（空 modelId = 不过滤）。
              const key = modelId ?? ''
              if (key.length === 0) return true
              if (!a.modelRateLimits) return true
              const resetAt = a.modelRateLimits[key]
              return resetAt === undefined || resetAt === 0 || Date.now() >= resetAt
            })
            .map(a => ({ id: a.id, credentialRef: a.credentialRef }))

          // 「锁定永久积分」：只允许消耗今日赠送额度（用户要求，且持久化）。
          const allowPermanent = !pool.permanentLocked(LOOMY.id)

          if (candidates.length > 0) {
            const picked = await loomyBalanceSelector.select(candidates, { allowPermanent })
            if (picked.ok) {
              const credential = await resolveLoomyCredentialByRef(picked.account.credentialRef)
              // Token 账本（第 2 期）：回报「本笔请求解析出的账号」。
              if (credential !== undefined) {
                reportLedgerAccount(LOOMY.id, picked.account.id)
                return credential
              }
            } else if (!allowPermanent) {
              // ⚠️ **锁定时绝不可落到下面的单凭据兜底** —— 那会绕过锁定、
              // 照样消耗永久积分，锁定形同虚设。这里直接抛明确错误（用户要求）。
              //
              // ⚠️ **必须区分「真的用尽」与「查不到」**（真实缺陷，用户报障
              // 2026-09-29）：曾把两者混成一句「今日额度都已用尽」，于是
              // **一次网络抖动**就让用户被告知"钱花完了"（实测当时 4 个号里
              // 3 个还有 4965/5000/5000）—— 用户会去解锁或白等一天，而号其实有钱。
              const reason = picked.reason
              if (reason.kind === 'unknown') {
                throw new Error(
                  'Loomy：无法确认是否有可用账号。已锁定永久积分，而部分账号的余额查询失败'
                  + `（${reason.errors.slice(0, 2).join('；')}）。这些账号**可能仍有**今日额度 —— `
                  + '请重试，或在 Channel Pack 的 Loomy 面板检查凭据是否失效。',
                )
              }
              throw new Error(
                'Loomy：没有可用账号。已锁定永久积分，而所有账号的今日赠送额度都已用尽。'
                + '请在 Channel Pack 的 Loomy 面板解锁永久积分，或等待明日额度刷新。',
              )
            }
          }

          host.throwIfAllAccountsRateLimited(LOOMY, modelId)
          // 兜底：账号池为空/全部不可解析时，退回单凭据 ref。
          const resolved = await authContext.credentials.resolve(credentialRef(LOOMY.defaultCredentialRef))
          if (!resolved) return undefined
          try {
            return JSON.parse(resolved.value) as LoomyCredential
          } catch {
            return undefined
          }
        },
        refresh: async (accountId?: string) => {
          const entry = accountId === undefined ? undefined
            : pool.listAccountsByProvider(LOOMY.id).find(account => account.id === accountId)
          if (accountId !== undefined && entry === undefined) throw new Error('loomy: account no longer exists')
          if (entry) await loomy.refreshAccountCredential(entry.credentialRef, pool, entry.id)
          else await loomy.refresh()
          const resolved = await authContext.credentials.resolve(credentialRef(entry?.credentialRef ?? LOOMY.defaultCredentialRef))
          if (!resolved) throw new Error('loomy: credential no longer exists')
          return JSON.parse(resolved.value) as LoomyCredential
        },
        nextAccount: async (modelId, tried) => {
          const candidates = pool.listAccountsByProvider(LOOMY.id)
            .filter(account => account.enabled && !tried.has(account.id))
            .filter(account => !account.modelRateLimits?.[modelId] || Date.now() >= account.modelRateLimits[modelId]!)
            .map(account => ({ id: account.id, credentialRef: account.credentialRef }))
          const picked = await loomyBalanceSelector.select(candidates, { allowPermanent: !pool.permanentLocked(LOOMY.id) })
          if (!picked.ok) return undefined
          const credential = await resolveLoomyCredentialByRef(picked.account.credentialRef)
          if (!credential) return undefined
          reportLedgerAccount(LOOMY.id, picked.account.id)
          return { accountId: picked.account.id, credential }
        },
        // 远端模型目录：GET /api/v1/models。
        // ⚠️ 必须用 **token 头**（业务端点），不是 Bearer —— 带错会得到
        // `100002 缺少 token`，表现为「模型列表永远停在兜底表」。
        // 失败时返回空数组，由适配器回退兜底表。
        fetchRemoteModels: async () => {
          const available = await pool.getAvailableAccount(LOOMY.id, '')
          const resolved = available !== null && available !== undefined
            ? { value: JSON.stringify(available.credential) }
            : await authContext.credentials.resolve(credentialRef(LOOMY.defaultCredentialRef))
          if (resolved === undefined) return []
          let credential: LoomyCredential
          try {
            credential = JSON.parse(resolved.value) as LoomyCredential
          } catch {
            return []
          }
          const response = await fetch(`${LOOMY.apiBase}/models`, {
            headers: { Accept: 'application/json', token: credential.access_token },
            signal: AbortSignal.timeout(30_000),
          })
          if (!response.ok) return []
          return parseLoomyRemoteModels(await response.json())
        },
        // 图片字节桥接：按模型能力判定（远端 capabilities.input_modalities 含 image）。
        readImage: host.readImage,
        accountPool: pool,
        product: LOOMY,
      })
    },
    // 定时续期：必须刷池内账号（`LOOMY_ACCESS_TOKEN` 从未被写入过）。
    refreshAll: async (target) => {
      await auth?.refreshAll(target)
    },
  }
}
