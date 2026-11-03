/**
 * Buddy 系（腾讯 CodeBuddy / WorkBuddy）两个渠道的装配描述。
 *
 * 本文件是 `index.ts` 中原两个 buddy 装配块的**原样搬运**：options 内容与注释
 * 逐字保留，只把宿主依赖（账号池、图片桥接、全限流报错）改成注册表注入。
 *
 * 两个产品同源（同后端、同协议），差异全部由 product 配置承载，故选号 / 凭据
 * 解析这两块共用一份实现 —— 与原来「一个 `pickBuddyCredential` 服务两个 adapter」
 * 的结构一致。
 *
 * @module channels/buddy
 */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { BUDDY_CREDENTIAL_REF, BuddyAuth, createPoolRefresh } from '../buddy-auth.js'
import { registerBuddyLlm } from '../buddy-adapter.js'
import { CODEBUDDY, WORKBUDDY, type BuddyProduct } from '../product.js'
import type { BuddyCredential } from '../types.js'
import type { AccountPool } from '../account-pool.js'
import type { ChannelAuthInstance, ChannelHost, ChannelSpec } from '../channel-registry.js'
import { reportLedgerAccount } from '../token-ledger.js'
import { buddyExpiringWindowDays } from '../buddy-balance-rank.js'
import { BuddyBalanceSelector, pickBuddyAccount } from '../buddy-balance-selector.js'

/** Buddy 的 Auth 在注册表最小接口之外的额外能力。 */
export interface BuddyChannelAuth extends ChannelAuthInstance {
  refreshAccountCredential(ref: string, pool: AccountPool, accountId: string): Promise<void>
  refresh(): Promise<void>
  fetchModels(pool?: AccountPool): Promise<unknown[]>
  refreshAll(pool: AccountPool): Promise<void>
}

/** 装配期需要、但不属于 `ChannelHost` 的依赖。 */
export interface BuddyChannelDeps {
  readonly pool: AccountPool
}

/** 一个 buddy 产品需要的那份附加信息（两个产品只在这几项上不同）。 */
interface BuddyChannelOptions {
  readonly product: BuddyProduct
  readonly namespace: string
  readonly displayName: string
}

export function createBuddyChannel(deps: BuddyChannelDeps): ChannelSpec {
  return makeBuddyChannel(deps, { product: CODEBUDDY, namespace: 'llm-buddy', displayName: 'CodeBuddy' })
}

export function createWorkBuddyChannel(deps: BuddyChannelDeps): ChannelSpec {
  return makeBuddyChannel(deps, { product: WORKBUDDY, namespace: 'llm-workbuddy', displayName: 'WorkBuddy' })
}

function makeBuddyChannel(deps: BuddyChannelDeps, options: BuddyChannelOptions): ChannelSpec {
  const { pool } = deps
  const { product, displayName } = options
  let auth: BuddyAuth | undefined

  /**
   * 按凭据 ref 解析 buddy 系凭据（CodeBuddy 与 WorkBuddy **共用这一个函数**）。
   *
   * 两站凭据同构（同一 CLI 内核、同一认证协议），差别只在 endpoint；
   * 解析这件事与 endpoint 无关，故不写两份。
   */
  const resolveBuddyCredentialByRef = async (refName: string): Promise<BuddyCredential | undefined> => {
    const resolved = await authContext.credentials.resolve(credentialRef(refName))
    if (!resolved) return undefined
    try {
      return JSON.parse(resolved.value) as BuddyCredential
    } catch {
      return undefined
    }
  }

  // 由 createAuth 填，registerLlm / resolveBuddyCredentialByRef 在装配后才用。
  let authContext: Context = undefined as unknown as Context

  /**
   * 本产品的**按到期分档选号器**（两个 buddy 各自一份余额缓存，绝不串味）。
   *
   * ⚠️ **为什么需要它**：一个 buddy 账号常同时持有多种资源包（实测 WorkBuddy
   * 每个号都有「Bonus Pack（14 天到期）」+「Free Plan Subscription（扣费截止
   * 8 年后）」），而**服务端扣哪个包不由插件决定**。插件能决定的只有「用哪个号」：
   * 优先用还有「15 天内到期积分」的号（那部分再不用就作废），只剩长期积分的号
   * 排最后 —— 与「锁定永久积分」配套（锁定时后者直接判不可用）。
   *
   * 判据出处见 `buddy-balance-rank.ts`（为什么是 15 天、为什么用 DeductionEndTime
   * 而不是 CycleEndTime / ExpiredTime，都有实测对照）。
   */
  const balanceSelector = new BuddyBalanceSelector({ product, resolveCredential: resolveBuddyCredentialByRef })

  /**
   * buddy 系的选号编排：按「enabled + 模型未受限」筛候选 → 按余额分档选号 → 取凭据。
   *
   * ⚠️ 余额分档**只在这批候选内部进行** —— 策略建立在「模型没有受限且账号没有被
   * 停用」的基础上，不能因为某个号积分多就绕开限流标记。
   *
   * @returns 选中账号的凭据；`credential` 为空时 `tried` 是「档位最优但凭据坏了」
   * 的账号集合，调用方要把它作为排除集合传给 `getAvailableAccount` 继续兜底。
   *   锁定且无可用账号时**抛错**（绝不回落，否则锁定形同虚设）。
   */
  const pickCredential = async (input: {
    modelId?: string
    /**
     * 本次请求的模型是否**免费**（消耗 0 积分），由调用方用
     * `BuddyAdapter.isFreeModel()` 判定后传入。
     *
     * ⚠️ 必须是**已确认**的免费：`true` 会跳过余额分档（即不受永久积分锁定约束），
     * 误判成免费会让付费模型绕开锁定、真烧掉永久积分。故调用方只在确定时传 true。
     */
    isFreeModel?: boolean
  }): Promise<{ credential?: BuddyCredential; tried: Set<string> }> => {
    const tried = new Set<string>()
    const candidates = pool
      .listAccountsByProvider(product.id)
      .filter(a => a.enabled)
      .filter((a) => {
        // 与 `getAvailableAccount` 的限流判据保持一致（空 modelId = 不过滤）。
        const key = input.modelId ?? ''
        if (key.length === 0) return true
        if (!a.modelRateLimits) return true
        const resetAt = a.modelRateLimits[key]
        return resetAt === undefined || resetAt === 0 || Date.now() >= resetAt
      })
      .map(a => ({ id: a.id, credentialRef: a.credentialRef }))

    // 免费模型（消耗 0 积分）不受「锁定永久积分」约束：锁定要保护的是
    // 「别把永久积分烧掉」，而免费模型既不扣临时积分也不扣永久积分，
    // 却被那道门一并拦下，报出「账号有余额却没有可用账号」的矛盾错误（真实报障）。
    //
    // 这里**只按候选顺序取凭据**，不做余额分档 —— 免费模型没有「该烧哪个包」的
    // 选择问题，余额查询因此完全不必要（也顺带省掉一次网络请求）。
    // 限流过滤仍然生效（上面的 filter），不会因免费而绕开模型级限流标记。
    if (input.isFreeModel === true) {
      for (const candidate of candidates) {
        const credential = await resolveBuddyCredentialByRef(candidate.credentialRef)
        if (credential !== undefined) return { credential, tried }
        tried.add(candidate.id)
      }
      // 免费模型下若凭据全坏，仍落到下面的常规路径，以复用既有的错误语义
      // （凭据问题应报「凭据不可用」，而不是被误报成「额度已用尽」）。
    }

    const allowPermanent = !pool.permanentLocked(product.id)

    const picked = await pickBuddyAccount(balanceSelector, candidates, {
      allowPermanent,
      resolveCredential: resolveBuddyCredentialByRef,
    })
    if (picked.kind === 'account') {
      return { credential: picked.credential, tried: new Set(picked.tried) }
    }
    for (const id of picked.tried) tried.add(id)
    if (picked.kind === 'locked') {
      // ⚠️ **锁定时绝不可落到调用方的 `getAvailableAccount` 兜底** —— 那会绕过
      // 锁定、照样消耗永久积分，锁定形同虚设（与 Loomy 那条同因）。
      const days = buddyExpiringWindowDays()
      // ⚠️ 同样要区分「真的用尽」与「查不到」（与 Loomy 那条同型缺陷）：
      // 把一次网络抖动报成"额度已用尽"，用户会去解锁或白等，而号其实有钱。
      if (picked.reason?.kind === 'unknown') {
        throw new Error(
          `${displayName}：无法确认是否有可用账号。已锁定永久积分，而部分账号的余额查询失败`
          + `（${picked.reason.errors.slice(0, 2).join('；')}）。这些账号**可能仍有**「${days} 天内到期」`
          + '的积分 —— 请重试，或在 Channel Pack 对应面板检查凭据是否失效。',
        )
      }
      throw new Error(
        `${displayName}：没有可用账号。已锁定永久积分，而所有账号的「${days} 天内到期」`
        + '积分都已用尽。请在 Channel Pack 的 '
        + `${displayName} 面板解锁永久积分，或等待资源包到期后重新发放额度。`,
      )
    }
    return { tried }
  }

  return {
    id: product.id,
    namespace: options.namespace,
    createAuth: (ctx) => {
      authContext = ctx
      auth = new BuddyAuth(ctx, product === WORKBUDDY ? { product: WORKBUDDY } : undefined)
      return auth as unknown as ChannelAuthInstance
    },
    registerLlm: (ctx: Context, host: ChannelHost) => {
      let adapter: ReturnType<typeof registerBuddyLlm>
      adapter = registerBuddyLlm(ctx, {
        credentialRef: credentialRef(product === WORKBUDDY ? WORKBUDDY.defaultCredentialRef : BUDDY_CREDENTIAL_REF),
        resolveCredential: async (modelId?: string) => {
          // 优先按「快到期积分」分档选号（锁定永久积分时也走这条，见上）。
          const picked = await pickCredential({
            modelId,
            // 免费模型跳过「锁定 + 临期积分」这道门（判据见 BuddyAdapter.isFreeModel）。
            // `adapter` 在此处是自引用：闭包只在注册完成后才执行，故无 TDZ 问题。
            isFreeModel: await adapter.isFreeModel(modelId),
          })
          if (picked.credential) return picked.credential
          // 回退到账号池的既有选择（凭据损坏的账号已被 tried 排除），最后才退单凭据 ref。
          // provider 实参用 product.id 而非字面量：写死字面量在改名/多产品
          // 场景下会静默查不到账号（本插件在 workbuddy 上踩过同类坑）。
          // ⚠️ `modelId` 必须透传：限流按**模型**记（`modelRateLimits[model]`），
          // 传空串会让 `getAvailableAccount` 的限流过滤整体短路
          //（`if (modelId.length === 0) return true`）→ 被标记限流的账号仍被选中。
          const available = await pool.getAvailableAccount(product.id, modelId ?? '', picked.tried)
          // Token 账本（第 2 期）：回报「本笔请求解析出的账号」。
          if (available) {
            reportLedgerAccount(product.id, available.entry.id)
            return available.credential as BuddyCredential
          }
          // 退到单凭据 ref 之前先证明失败原因：全被模型限流时报明确的限流错误，
          // 而不是让它降级成误导性的 MISSING_CREDENTIAL（见该助手的说明）。
          host.throwIfAllAccountsRateLimited(product, modelId)
          const resolved = await ctx.credentials.resolve(credentialRef(product.defaultCredentialRef))
          if (!resolved) return undefined
          try {
            return JSON.parse(resolved.value) as BuddyCredential
          } catch {
            return undefined
          }
        },
        // 刷新**账号池里实际使用的那一个账号**，而不是默认单凭据 ref ——
        // 后者在 Channel Pack 登录路径下根本不存在，会把 401 报成「未配置凭据」
        // 并自锁。详见 createPoolRefresh 的注释。
        refresh: createPoolRefresh(pool, product.id, auth as BuddyAuth),
        fetchRemoteModels: () => (auth as BuddyAuth).fetchModels(pool),
        readImage: host.readImage,
        // 图片请求版本（缩放）桥接：issue !IKITT9。不可用时适配器自动回退原图。
        readImageRequest: host.readImageRequest,
        accountPool: pool,
        product,
      })
      return adapter
    },
    // 定时续期：必须刷池内账号（`*_ACCESS_TOKEN` 从未被写入过）。
    // workbuddy 那条正是「workbuddy + deepseek-v4.1-flash 一直报未配置凭据」的根因。
    refreshAll: async (target) => {
      await auth?.refreshAll(target)
    },
    // WorkBuddy provider 已从中国版（copilot.tencent.com）改造为国际版
    // （www.workbuddy.ai）。旧账号存的是中国版凭据，其 token.domain 指向旧端点，
    // 用新 endpoint 发请求必然失败且会一直续期失败，故启动时清理掉。
    // 判据是「凭据 domain ≠ 产品 apiDomain」，只清真正失配的条目。
    afterMount: product === WORKBUDDY
      ? (ctx) => {
          void pool.pruneAccountsWithForeignDomain(WORKBUDDY).then((removed) => {
            if (removed.length > 0) {
              ctx.logger.info(
                `[channel-pack] 已清理 ${removed.length} 个 WorkBuddy 旧版（中国版）账号，请重新登录：${removed.join(', ')}`,
              )
            }
          }).catch((error: unknown) => {
            ctx.logger.warn(`[channel-pack] 清理 WorkBuddy 旧版账号失败：${String(error)}`)
          })
        }
      : undefined,
  }
}
