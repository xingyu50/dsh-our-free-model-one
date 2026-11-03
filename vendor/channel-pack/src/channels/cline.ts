/**
 * Cline（Cline 桌面端 / Cline API）渠道的装配描述。
 *
 * 本文件是 `index.ts` 中原 Cline 装配块的**原样搬运**：options 内容与注释
 * 逐字保留，只把宿主依赖（账号池、图片桥接、全限流报错、网络出口）改成注入。
 *
 * @module channels/cline
 */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { ClineAuth } from '../cline-auth.js'
import { registerClineLlm } from '../cline-adapter.js'
import { CLINE } from '../cline-product.js'
import type { ClineCredential } from '../cline.js'
import type { AccountPool } from '../account-pool.js'
import type { ChannelAuthInstance, ChannelHost, ChannelSpec } from '../channel-registry.js'
import { reportLedgerAccount } from '../token-ledger.js'

/** Cline 的 Auth 在注册表最小接口之外的额外能力。 */
export interface ClineChannelAuth extends ChannelAuthInstance {
  refreshAccountCredential(ref: string, pool: AccountPool, accountId: string): Promise<void>
  refresh(): Promise<void>
  refreshAll(pool: AccountPool): Promise<void>
}

/** 装配期需要、但不属于 `ChannelHost` 的依赖。 */
export interface ClineChannelDeps {
  readonly pool: AccountPool
  /** 渠道网络出口（Auth 与适配器都必须用它）。 */
  readonly fetcher: typeof fetch
}

export function createClineChannel(deps: ClineChannelDeps): ChannelSpec {
  const { pool, fetcher } = deps
  let authContext: Context = undefined as unknown as Context
  let auth: ClineAuth | undefined
  /**
   * 「本次实际使用的是哪个 Cline **池账号**」——「订阅额度 → 请求记录」的
   * 「账号」列按它归属，面板也是用这个 id 过滤的。
   *
   * ⚠️ 与 Qoder 的 `activeAccountId` 同因：必须在 `resolveCredential` 里记录
   * **实际返回的那个账号**，不能事后自己再查一次池 —— 池的选号是即时决策，
   * 与适配器本次拿到的凭据可能已经不是一个账号。
   *
   * ⚠️ 真实缺陷（用户报障「请求记录中数据空白」）：此处曾**完全没有**这个通道，
   * 适配器只好退回记凭据里的 `account_id`（`usr-…`），而面板按池 id
   * （`cline-bb211a53`）过滤 → 两个 id 空间不一致 → 表格永远空白。
   */
  let activeClineAccountId = ''
  return {
    id: CLINE.id,
    namespace: 'llm-cline',
    createAuth: (ctx) => {
      authContext = ctx
      auth = new ClineAuth(ctx, { fetcher })
      return auth as unknown as ChannelAuthInstance
    },
    registerLlm: (ctx: Context, host: ChannelHost) => {
      const cline = auth as unknown as ClineChannelAuth
      return registerClineLlm(ctx, {
        fetchImpl: fetcher,
        credentialRef: credentialRef(CLINE.defaultCredentialRef),
        resolveCredential: async (modelId?: string) => {
          // 只从 Cline 自己的账号池取账号，回退到自己的单凭据 ref，
          // 保证不会串用其它 provider 的凭据。
          // provider 实参用 CLINE.id 而非字面量 'cline'：写死字面量在
          // 改名/多产品场景下会静默查不到账号。
          const available = await pool.getAvailableAccount(CLINE.id, modelId ?? '')
          // 记录实际选中的池账号（空串 = 回退到单凭据 ref 模式，见适配器注释）。
          activeClineAccountId = available?.entry.id ?? ''
          // Token 账本（第 2 期）：回报「本笔请求解析出的账号」（空串不回报）。
          if (activeClineAccountId.length > 0) reportLedgerAccount(CLINE.id, activeClineAccountId)
          if (available) return available.credential as ClineCredential

          // 唯一的 cline 账号被**模型级限流**标记挡住时，候选会筛成空集，最终降级成
          // `cline: no usable credential; log in first` —— 凭据明明在、账号也登录着，
          // 用户却被指去重新登录，方向完全错。故必须在退到单凭据 ref **之前**
          // 先把「其实是限流，预计 X 后解禁」说清楚。
          host.throwIfAllAccountsRateLimited(CLINE, modelId)
          const resolved = await authContext.credentials.resolve(credentialRef(CLINE.defaultCredentialRef))
          if (!resolved) return undefined
          try {
            return JSON.parse(resolved.value) as ClineCredential
          } catch {
            return undefined
          }
        },
        refresh: async () => {
          // 必须刷新**解析凭据时所用的那一个**账号，而不是默认单凭据 ref。
          //
          // 为什么：resolveCredential（上面）优先从账号池取
          // `CLINE_ACCOUNT_XXX` 的凭据，而 `cline.refresh()` 读写的是
          // `CLINE_ACCESS_TOKEN`。两者错配的后果是 —— 适配器检测到池凭据
          // 过期 → 调 refresh → 成功回写到**另一个** ref → 再 resolve 仍取到
          // 那份未更新的过期凭据 → 带着过期 token 发请求 → 401。
          // 用户看到的是「刚在 Channel Pack 登录好，却一直认证失败」，
          // 而日志里续期全是成功的，极难排查。
          const available = await pool.getAvailableAccount(CLINE.id, '')
          if (available) await cline.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id)
          else await cline.refresh()
        },
        // 图片字节桥接：Cline 内嵌目录的 `capabilities` 含 `images`，
        // 模态按模型判定（见 ClineAdapter.inputModalitiesFor）。
        readImage: host.readImage,
        // 图片请求版本（缩放）桥接：issue !IKITT9。该家实测 24 张原图全过、
        // 32 张（≈122 MiB）才 `TRANSPORT` —— 余量比其他家大，但仍需兜住长会话。
        readImageRequest: host.readImageRequest,
        accountPool: pool,
        // 「请求记录」的账号归属（见上面的 activeClineAccountId）。
        currentAccountId: () => activeClineAccountId.length > 0 ? activeClineAccountId : undefined,
        product: CLINE,
      })
    },
    // 定时续期：必须刷池内账号（`CLINE_ACCESS_TOKEN` 从未被写入过）。
    refreshAll: async (target) => {
      await auth?.refreshAll(target)
    },
  }
}
