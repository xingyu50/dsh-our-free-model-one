/**
 * 积分端点（签到状态 / 一键领取 / 积分余额）的渠道分派表。
 *
 * ## 为什么存在
 *
 * 这三条 RPC 原本是 `channel-pack-rpc.ts` 里三个大 `case`（status 96 行、
 * claimAll 249 行、balances 430 行），按 `req.provider` 逐家 `if` 分派，
 * 同一段「取账号 → 解析凭据 → 逐条收集」被手抄了六次（qoder / cline / loomy /
 * raccoon / zcode 的余额、loomy / zcode 的领取），五个渠道的「没有状态端点」
 * 块更是逐字相同。新增一个渠道要往 `switch` 里插一支 `if`，没有编译器检查
 * 「这个渠道漏了哪个动词」。
 *
 * 本模块把「哪个渠道支持哪个动词、怎么实现」收成一张按渠道 id 索引的表：
 * 新增渠道只加一条表项；三条 `case` 各剩五行。
 *
 * ## 模块归属
 *
 * 本文件与 `channel-pack-rpc.ts` / `index.ts` 同属**装配层**：它按渠道 id 引用
 * 各渠道的 `*-credits.ts` 与 Auth 实例，正是 GLOSSARY 里「适配器可以依赖共享层」
 * 之外的另一条 —— 装配层可以依赖适配器。判据是「谁把渠道按名字列出来」：
 * 列名字的只能是装配层，不能是 `account-pool.ts` / `credits.ts` 这类共享层。
 *
 * Auth 实例不在这里 import：一律经 {@link CreditsChannelDeps} 注入，于是这张表
 * 可以脱离整个插件宿主单测（见 `scripts/channel-credits-dispatch-test.mjs`）。
 *
 * ## 不许改变的东西
 *
 * 三条动词的**文案与顺序**是既有契约：`unsupported provider: <id>`、三种
 * 「不支持签到」、六处「凭据未配置 / 凭据解析失败 / 积分查询失败（凭据失效或
 * 响应异常）」。搬代码时逐字保留。`req.force` 只有 Gemini 读。
 *
 * @module credits-channels
 */
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { claimDailyCheckin, claimUnitOf, fetchCheckinStatus, fetchCreditBalance, type CheckinStatus, type ClaimOutcome, type CreditBalance } from './credits.js'
import type { BuddyCredential } from './buddy.js'
import { CODEBUDDY, WORKBUDDY, type BuddyProduct } from './product.js'
// CodeArts 没有产品常量（它不出现在 ALL_PRODUCTS 里），渠道 id 的唯一出处是
// 适配器导出的 PROVIDER —— 本文件是装配层，必须按名字引用而不是内联字面量。
import { PROVIDER as CODEARTS_PROVIDER } from './llm-adapter.js'
import { buddyExpiringWindowDays } from './buddy-balance-rank.js'
import { creditExpiringWindowDays } from './credit-expiry-window.js'
import { LOOMY } from './loomy-product.js'
import type { LoomyCredential } from './loomy.js'
import { LOBSTERAI } from './lobsterai-product.js'
import type { LobsteraiCredential } from './lobsterai.js'
import { claimLobsteraiDailyCheckin, fetchLobsteraiCreditBalance } from './lobsterai-credits.js'
import { QODER, QODER_CN, type QoderProduct } from './qoder-product.js'
import type { QoderCredential } from './qoder.js'
import { claimQoderDailyCheckin, fetchQoderCreditBalance } from './qoder-credits.js'
import { RACCOON } from './raccoon-product.js'
import type { RaccoonCredential } from './raccoon.js'
import { TRAE } from './trae-product.js'
import type { TraeCredential } from './trae.js'
import { claimTraeDailyCheckin, fetchTraeCheckinStatus, fetchTraeCreditBalance } from './trae-credits.js'
import { CLINE } from './cline-product.js'
import type { ClineCredential } from './cline.js'
import { fetchClineCreditBalance } from './cline-credits.js'
import { MINIMAX } from './minimax-product.js'
import type { MinimaxCredential } from './minimax.js'
import { claimMinimaxDailyCheckin, fetchMinimaxCreditBalance, fetchMinimaxSigninStatus } from './minimax-credits.js'
import { GEMINI, type GeminiCredential } from './gemini.js'
import { fetchGeminiCreditBalance } from './gemini-credits.js'
import { OPENCODE } from './opencode-product.js'
import { ZCODE } from './zcode-product.js'
import type { ZcodeCredential } from './zcode.js'
import type { ZcodeBalanceResult } from './zcode-upstream.js'
import type { ZcodeCaptchaConfig } from './zcode-captcha.js'
import type { CodeArtsCredential, ProviderAccountEntry, RpcCreditsBalanceExtra, RpcCreditsBalancesRequest, RpcCreditsBalancesResponse, RpcCreditsClaimAllResponse, RpcCreditsClaimSummary, RpcCreditsStatusResponse } from './types.js'
import { fetchCodeArtsAccountInfoDetailed, claimCodeArtsDailyCheckin } from './codearts-credits.js'

/** 动词的响应信封，与 `channel-pack-rpc.ts` 的 `{ ok, value | error }` 同形。 */
export type CreditsVerbResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** 三个动词的全部注入依赖；全是闭包，调用时才取实例方法（测试可替换）。 */
export interface CreditsChannelDeps {
  resolve(ref: CredentialRef): Promise<{ value: string } | undefined>
  warn?(message: string): void
  /** TRAE 的签到设备代次落在账号池上（账号级状态，不是渠道级状态）。 */
  readonly trae: {
    generationFor(accountId: string): number
    updateGeneration(accountId: string, next: number): Promise<void>
  }
  /** LobsterAI 领取要带客户端版本号；版本探测本身是一次缓存查询。 */
  lobsterAiClientVersion(): Promise<string>
  readonly loomy: {
    claimDailyQuota(credential: LoomyCredential): Promise<ClaimOutcome>
    fetchCreditBalance(credential: LoomyCredential): Promise<CreditBalance | null>
  }
  readonly raccoon: { fetchCreditBalance(credential: RaccoonCredential): Promise<CreditBalance | null> }
  readonly zcode: {
    claimDailyFor(credential: ZcodeCredential, mintCaptcha: (config: ZcodeCaptchaConfig) => Promise<string>): Promise<ClaimOutcome[]>
    mintCaptcha(config: ZcodeCaptchaConfig): Promise<string>
    fetchBalanceFor(credential: ZcodeCredential): Promise<ZcodeBalanceResult | undefined>
  }
}

/** 一个渠道在这三条 RPC 上的实现；缺哪个动词就是「该渠道不支持它」。 */
export interface CreditsChannel {
  /** 查询签到状态。缺省 = 走 `unsupported provider`（与旧 `switch` 的兜底同款）。 */
  readonly status?: (accounts: readonly ProviderAccountEntry[]) => Promise<CreditsVerbResult<RpcCreditsStatusResponse>>
  /** 一键领取。缺省 = 该渠道不支持领取。 */
  readonly claim?: (accounts: readonly ProviderAccountEntry[]) => Promise<CreditsVerbResult<RpcCreditsClaimAllResponse>>
  /** 查询积分余额。缺省 = 该渠道不支持余额查询。 */
  readonly balances?: (
    accounts: readonly ProviderAccountEntry[],
    request: RpcCreditsBalancesRequest,
  ) => Promise<CreditsVerbResult<RpcCreditsBalancesResponse>>
}

function ok<T>(value: T): CreditsVerbResult<T> { return { ok: true, value } }

/** 「这个渠道不存在」的坏请求；文案是既有契约，逐字保留。 */
export function unsupportedProvider(provider: string): CreditsVerbResult<never> {
  return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${provider}` } }
}

/** 渠道确实存在、但其后端没有签到接口时的坏请求（各渠道各自说明原因）。 */
function unsupportedCheckin(message: string): CreditsVerbResult<never> {
  return { ok: false, error: { code: 'bad-request', message } }
}

/**
 * 五个渠道的「没有状态端点」共同实现。
 *
 * 它们的可领状态要经多步协议才能得到（CodeArts 两步、Loomy 由领取接口触发），
 * 且与 CodeBuddy 的 CheckinStatus 不同构，故如实回 `null`，不臆造一份状态。
 */
function nullStatus(accounts: readonly ProviderAccountEntry[]): RpcCreditsStatusResponse {
  return { accounts: accounts.map((entry) => ({ accountId: entry.id, nickname: entry.nickname, status: null })) }
}

/** 查询/领取端点共用的最小依赖：凭据解析 + 告警出口。 */
function endpointDeps<T extends object>(deps: CreditsChannelDeps, extra?: T) {
  return { resolve: deps.resolve, warn: deps.warn, ...extra }
}

/**
 * 汇总一次批量领取的结果（纯函数）。
 *
 * ★ **按单位分开累加**（2026-10-04，真实缺陷）：`totalCredit` 这个标量会把不同
 * 量纲加在一起（ZCode 的 1 亿 token + 100 积分 = `100000100`）。`totalCredit`
 * **保留原语义**只为不破坏既有契约，展示一律用 `totalByUnit`。
 *
 * `coversToday` 只在 `outcome.coversToday !== false` 时累加 —— 那是渠道自己标的
 * 「这一轮没有覆盖今天」（当前只有 Qoder 刷新前那一轮这么标），见自动签到
 * `shouldMarkToday()` 的判据。
 */
export function computeClaimSummary(outcomes: readonly ClaimOutcome[]): RpcCreditsClaimSummary {
  const summary: RpcCreditsClaimSummary = {
    claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, failed: 0, coversToday: 0,
    totalByUnit: { token: 0, credit: 0 },
  }
  for (const outcome of outcomes) {
    switch (outcome.kind) {
      case 'claimed':
        summary.claimed += 1
        summary.totalCredit += outcome.credit
        // 单位缺省按 `credit`（与 `ClaimOutcome.unit` 的声明一致）；只有 ZCode 显式传 token。
        summary.totalByUnit[claimUnitOf(outcome.unit)] += outcome.credit
        if (outcome.coversToday !== false) summary.coversToday += 1
        break
      case 'already-claimed':
        summary.alreadyClaimed += 1
        if (outcome.coversToday !== false) summary.coversToday += 1
        break
      case 'inactive':
        summary.inactive += 1
        break
      case 'failed':
        summary.failed += 1
        break
      default: {
        // 编译期穷尽性检查：`ClaimOutcome` 新增 kind 时这里会报错，迫使作者显式
        // 决定它计入哪一栏，而不是被静默漏计。
        const exhaustive: never = outcome
        void exhaustive
        // 运行期兜底：未知 kind 按 failed 计入。
        summary.failed += 1
        break
      }
    }
  }
  return summary
}

/** 逐账号处理三件套的可注入依赖。 */
export interface CreditsEndpointDeps<TCredential = unknown, TProduct = unknown> {
  /** 解析凭据引用。该接口**不可信**（凭据可能已被外部删除），异常算在单个账号头上。 */
  resolve(ref: CredentialRef): Promise<{ value: string } | undefined>
  /** 查询签到状态；默认使用真实的 `fetchCheckinStatus`。 */
  fetchStatus?: (credential: TCredential, product: TProduct) => Promise<CheckinStatus | null>
  /** 执行签到领取；默认使用真实的 `claimDailyCheckin`。 */
  claim?: (credential: TCredential, product: TProduct, entry: ProviderAccountEntry) => Promise<ClaimOutcome>
  /** 查询积分余额；默认使用真实的 `fetchCreditBalance`。 */
  fetchBalance?: (credential: TCredential, product: TProduct) => Promise<CreditBalance | null>
  /** 余额查询的**带原因**版本（优先于 {@link fetchBalance}）。 */
  fetchBalanceDetailed?: (
    credential: TCredential,
    product: TProduct,
  ) => Promise<{ balance: CreditBalance | null; error?: string; extra?: RpcCreditsBalanceExtra }>
  /** 单账号异常时的告警出口（不参与控制流）。 */
  warn?: (message: string) => void
  /** 领取前是否先查一次签到状态（默认 `true`）。 */
  precheckStatus?: boolean
  /**
   * 默认实现（`fetchCheckinStatus` / `claimDailyCheckin` / `fetchCreditBalance`）用的 fetch。
   *
   * ⚠️ **必须经此注入，不要在调用点直接 `fetch(...)`**：那些真实签名是
   * `(credential, product, fetcher)`，历史写法用 `as unknown as` 把三参函数硬转成
   * 「只传两个参数」的类型，于是调用点写 `claim(credential, product, entry)` 时
   * `entry` 落进了 `fetcher` 位，运行时抛 **`TypeError: fetcher is not a function`**
   * （真实缺陷：用户一键领取 4 个 CodeBuddy 账号全部失败）。
   */
  fetcher?: typeof fetch
}

/**
 * 逐账号收集签到状态（顺序执行，避免并发触发风控）。
 *
 * **包含已停用账号**：停用只影响账号池的自动选择与限流切换，不改变账号本身
 * 是否已签到。**凭据解析也在 try 之内** —— `credentialRef()` 会对名称做正则校验，
 * 留在 try 外会让任一账号的异常冒泡成整批 `channel-pack/handler-failed`。
 */
export async function collectCreditsStatus<TCredential = unknown, TProduct = unknown>(
  accounts: readonly ProviderAccountEntry[],
  product: TProduct,
  deps: CreditsEndpointDeps<TCredential, TProduct>,
): Promise<RpcCreditsStatusResponse['accounts']> {
  const fetcher = deps.fetcher ?? fetch
  const fetchStatus = deps.fetchStatus
    ?? (async (credential: TCredential, product2: TProduct): Promise<CheckinStatus | null> =>
      fetchCheckinStatus(
        credential as unknown as BuddyCredential,
        product2 as unknown as BuddyProduct,
        fetcher,
      ))
  const results: RpcCreditsStatusResponse['accounts'] = []
  for (const entry of accounts) {
    let status: CheckinStatus | null = null
    try {
      const resolved = await deps.resolve(credentialRef(entry.credentialRef))
      if (resolved !== undefined) {
        const credential = JSON.parse(resolved.value) as TCredential
        status = await fetchStatus(credential, product)
      }
    } catch (error) {
      deps.warn?.(`[channel-pack] credits.status 账号 ${entry.id} 失败: ${String(error)}`)
      status = null
    }
    results.push({ accountId: entry.id, nickname: entry.nickname, status })
  }
  return results
}

/**
 * 逐账号执行一键领取（顺序执行，单个账号失败不中断整体）。
 *
 * **包含已停用账号**：停用账号同样有当日积分可领，用户点「一键领取」时期望
 * 所有账号都尝试一遍。
 */
export async function collectClaimResults<TCredential = unknown, TProduct = unknown>(
  accounts: readonly ProviderAccountEntry[],
  product: TProduct,
  deps: CreditsEndpointDeps<TCredential, TProduct>,
): Promise<RpcCreditsClaimAllResponse> {
  // ⚠️ **默认实现必须显式适配，不能 `as unknown as` 硬转**（理由见
  // `CreditsEndpointDeps.fetcher`）。
  const fetcher = deps.fetcher ?? fetch
  const fetchStatus = deps.fetchStatus
    ?? (async (credential: TCredential, product2: TProduct): Promise<CheckinStatus | null> =>
      fetchCheckinStatus(
        credential as unknown as BuddyCredential,
        product2 as unknown as BuddyProduct,
        fetcher,
      ))
  const claim = deps.claim
    ?? (async (credential: TCredential, product2: TProduct): Promise<ClaimOutcome> =>
      claimDailyCheckin(
        credential as unknown as BuddyCredential,
        product2 as unknown as BuddyProduct,
        fetcher,
      ))
  const precheck = deps.precheckStatus !== false
  const results: RpcCreditsClaimAllResponse['results'] = []
  const outcomes: ClaimOutcome[] = []
  for (const entry of accounts) {
    let outcome: ClaimOutcome
    try {
      const resolved = await deps.resolve(credentialRef(entry.credentialRef))
      if (resolved === undefined) {
        outcome = { kind: 'failed', code: -1, message: '凭据未配置' }
      } else {
        const credential = JSON.parse(resolved.value) as TCredential
        if (!precheck) {
          // 领取流程自带状态判断（LobsterAI 的 slot/context 检查在 claim 内部）。
          outcome = await claim(credential, product, entry)
        } else {
          // 先查状态：活动未开启或今日已领则跳过领取请求，减少无效调用
          const status = await fetchStatus(credential, product)
          if (status !== null && !status.active) {
            outcome = { kind: 'inactive', message: '签到活动未开启' }
          } else if (status !== null && status.todayCheckedIn) {
            outcome = { kind: 'already-claimed', message: '今天已签到' }
          } else {
            // 状态查询失败（status 为 null）时仍然尝试领取：
            // 无法确认不代表不能领，交给领取接口以响应体 code 定夺。
            outcome = await claim(credential, product, entry)
          }
        }
      }
    } catch (error) {
      deps.warn?.(`[channel-pack] credits.claimAll 账号 ${entry.id} 失败: ${String(error)}`)
      outcome = {
        kind: 'failed', code: -1,
        message: error instanceof Error ? error.message : String(error),
      }
    }
    outcomes.push(outcome)
    results.push({ accountId: entry.id, nickname: entry.nickname, outcome })
  }
  return { results, summary: computeClaimSummary(outcomes) }
}

/**
 * 逐账号收集积分余额（顺序执行，避免并发触发风控）。
 *
 * 与 {@link collectCreditsStatus} 的关键差异：**这里保留失败原因**。余额查不到时
 * 用户最需要知道「为什么」（凭据过期？网络不通？），降级成 null 只会让账号卡片
 * 显示成空白或 0 分，反而误导。
 */
export async function collectCreditBalances<TCredential = unknown, TProduct = unknown>(
  accounts: readonly ProviderAccountEntry[],
  product: TProduct,
  deps: CreditsEndpointDeps<TCredential, TProduct>,
): Promise<RpcCreditsBalancesResponse['accounts']> {
  const fetcher = deps.fetcher ?? fetch
  const fetchBalance = deps.fetchBalance
    ?? (async (credential: TCredential, product2: TProduct): Promise<CreditBalance | null> =>
      fetchCreditBalance(
        credential as unknown as BuddyCredential,
        product2 as unknown as BuddyProduct,
        fetcher,
      ))
  const fetchDetailed = deps.fetchBalanceDetailed
  const results: RpcCreditsBalancesResponse['accounts'] = []
  for (const entry of accounts) {
    let balance: CreditBalance | null = null
    let error: string | undefined
    let extra: RpcCreditsBalanceExtra | undefined
    try {
      const resolved = await deps.resolve(credentialRef(entry.credentialRef))
      if (resolved === undefined) {
        error = '凭据未配置'
      } else {
        const credential = JSON.parse(resolved.value) as TCredential
        if (fetchDetailed !== undefined) {
          // 带原因的查询：实现自己决定「非积分账户」这类业务状态的文案。
          const detailed = await fetchDetailed(credential, product)
          balance = detailed.balance
          error = detailed.error
          extra = detailed.extra
          if (balance === null && error === undefined) error = '余额查询失败'
        } else {
          balance = await fetchBalance(credential, product)
          // 查询函数以 null 表示「查不到」（网络/业务码异常），与「余额为 0」不同
          if (balance === null) error = '余额查询失败'
        }
      }
    } catch (caught) {
      deps.warn?.(`[channel-pack] credits.balances 账号 ${entry.id} 失败: ${String(caught)}`)
      error = caught instanceof Error ? caught.message : String(caught)
      balance = null
    }
    results.push({
      accountId: entry.id,
      nickname: entry.nickname,
      balance,
      ...error === undefined ? {} : { error },
      ...extra === undefined ? {} : { extra },
    })
  }
  return results
}

/** 余额查不到时最常用的那句（六个渠道共用，逐字保留）。 */
const CREDITS_QUERY_FAILED = '积分查询失败（凭据失效或响应异常）'

/**
 * 逐账号余额查询的公共骨架（把六份逐字相同的手写 `for` 收成一份）。
 *
 * 骨架只负责三件事：解析凭据、把缺失/损坏凭据记成带原因的空余额、逐条 push。
 * 「查询失败怎么措辞」留给调用方 —— 那是渠道语义，不是骨架的事。
 *
 * ⚠️ 与原实现一致：**上游查询本身不在 try 之内**。各家上游函数按设计「不抛错、
 * 返回 null」，故这里也不额外兜底，行为逐字不变。
 */
async function collectAccountBalances<TCredential>(
  accounts: readonly ProviderAccountEntry[],
  deps: Pick<CreditsChannelDeps, 'resolve'>,
  query: (credential: TCredential) => Promise<{ balance: CreditBalance | null; error?: string }>,
): Promise<RpcCreditsBalancesResponse['accounts']> {
  const values: RpcCreditsBalancesResponse['accounts'] = []
  for (const account of accounts) {
    const resolved = await deps.resolve(credentialRef(account.credentialRef))
    if (!resolved) {
      values.push({
        accountId: account.id, nickname: account.nickname,
        balance: null, error: '凭据未配置',
      })
      continue
    }
    let credential: unknown
    try {
      credential = JSON.parse(resolved.value) as unknown
    } catch {
      values.push({
        accountId: account.id, nickname: account.nickname,
        balance: null, error: '凭据解析失败',
      })
      continue
    }
    const result = await query(credential as TCredential)
    values.push({
      accountId: account.id,
      nickname: account.nickname,
      balance: result.balance,
      ...result.error === undefined ? {} : { error: result.error },
    })
  }
  return values
}

/**
 * 逐账号领取的公共骨架（取代 Loomy / ZCode 两处手写 `for`）。
 *
 * `claim` 返回**数组**：ZCode 一个账号可能在多个 plan 上各产出一次结果，而
 * `RpcCreditsClaimAccountResult` 一次只装一条，故逐条展开。Loomy 恒为一条。
 */
async function collectAccountOutcomes<TCredential>(
  accounts: readonly ProviderAccountEntry[],
  deps: Pick<CreditsChannelDeps, 'resolve'>,
  claim: (credential: TCredential) => Promise<readonly ClaimOutcome[]>,
): Promise<RpcCreditsClaimAllResponse> {
  const results: RpcCreditsClaimAllResponse['results'] = []
  const outcomes: ClaimOutcome[] = []
  for (const account of accounts) {
    const resolved = await deps.resolve(credentialRef(account.credentialRef))
    let accountOutcomes: readonly ClaimOutcome[]
    if (!resolved) {
      accountOutcomes = [{ kind: 'failed', code: -1, message: '凭据未配置' }]
    } else {
      let credential: unknown | undefined
      try {
        credential = JSON.parse(resolved.value) as unknown
      } catch {
        credential = undefined
      }
      accountOutcomes = credential === undefined
        ? [{ kind: 'failed', code: -1, message: '凭据解析失败' }]
        : await claim(credential as TCredential)
    }
    for (const outcome of accountOutcomes) {
      results.push({ accountId: account.id, nickname: account.nickname, outcome })
      outcomes.push(outcome)
    }
  }
  return { results, summary: computeClaimSummary(outcomes) }
}

/**
 * ZCode 额度映射。
 *
 * 单位是 **token**（不是 credit），如实标注，避免用户以为 ZCode 有 1 亿积分。
 * 上游可能一个桶都不给（实测企业版之外仍有账号只有 0 桶）：此时给一个具名占位包，
 * 让 UI 至少能显示「0 / 0」，而不是把空 `packages` 渲染成「没有额度」。
 */
function buildZcodeBalance(result: ZcodeBalanceResult): CreditBalance {
  const packages: CreditBalance['packages'] = result.buckets.map((bucket) => {
    const remaining = bucket.availableUnits ?? bucket.remainingUnits ?? 0
    const total = bucket.totalUnits ?? 0
    return {
      name: bucket.showName ?? result.planName ?? 'ZCode 免费额度',
      unit: 'token',
      remaining,
      total,
      used: Math.max(0, total - remaining),
      active: true,
      // ZCode 的额度按日刷新（`period: 'one_time'` 的活动包到点失效），
      // 故周期起止都留空，只用 `expiredTime` 给到期时刻。
      cycleStartTime: '',
      cycleEndTime: '',
      expiredTime: bucket.expiresAt !== undefined
        ? new Date(bucket.expiresAt * 1000).toISOString()
        : (result.expiresAt !== undefined ? new Date(result.expiresAt * 1000).toISOString() : ''),
    }
  })
  if (packages.length === 0) {
    packages.push({
      name: result.planName ?? 'ZCode 免费额度',
      unit: 'token',
      remaining: 0,
      total: 0,
      used: 0,
      active: true,
      cycleStartTime: '',
      cycleEndTime: '',
      expiredTime: result.expiresAt !== undefined ? new Date(result.expiresAt * 1000).toISOString() : '',
    })
  }
  return { total: result.remaining, expiredTotal: 0, packages }
}

// ── 渠道表 ────────────────────────────────────────────────────────────────

const buddyChannel = (deps: CreditsChannelDeps, product: BuddyProduct): CreditsChannel => ({
  status: async (accounts) => ok({
    accounts: await collectCreditsStatus(accounts, product, endpointDeps(deps)),
  }),
  claim: async (accounts) => ok(await collectClaimResults(accounts, product, endpointDeps(deps))),
  balances: async (accounts) => ok({
    accounts: await collectCreditBalances(accounts, product, endpointDeps(deps)),
    windowDays: buddyExpiringWindowDays(),
  }),
})

const qoderChannel = (deps: CreditsChannelDeps, product: QoderProduct): CreditsChannel => ({
  // Qoder 的领取流程**自带活动列表查询**（loadCampaigns → 逐个 claim），故跳过
  // 外部那次状态检查，否则会重复发一次 GET。幂等判据在响应体的 `replayed`。
  claim: async (accounts) => ok(await collectClaimResults<QoderCredential, undefined>(accounts, undefined, {
    ...endpointDeps(deps),
    claim: (credential) => claimQoderDailyCheckin(credential, product),
    precheckStatus: false,
  })),
  balances: async (accounts) => ok({
    accounts: await collectAccountBalances(accounts, deps, async (credential: QoderCredential) => {
      const balance = await fetchQoderCreditBalance(credential, product)
      return { balance, ...balance === null ? { error: CREDITS_QUERY_FAILED } : {} }
    }),
  }),
})

/**
 * 建表：`channel-pack-rpc.ts` 只按渠道 id 取一条 spec，不再逐家 `if`。
 *
 * 表里没有的渠道 = 三个动词全不支持（RPC 回 `unsupported provider: <id>`）。
 */
export function channelCredits(deps: CreditsChannelDeps): Readonly<Record<string, CreditsChannel>> {
  return {
    [CODEBUDDY.id]: buddyChannel(deps, CODEBUDDY),
    [WORKBUDDY.id]: {
      // WorkBuddy 国际版只有余额：签到接口在其后端并不存在。
      // ⚠️ 领取必须显式拒绝，不能落进 CodeBuddy 那套默认实现 —— 否则会用
      // 国际版凭据去发国内版签到接口（早期真实缺陷）。
      status: async (accounts) => ok({ accounts: await collectCreditsStatus(accounts, WORKBUDDY, endpointDeps(deps)) }),
      claim: async () => unsupportedCheckin('WorkBuddy 国际版不支持每日签到（其后端没有签到接口）'),
      balances: async (accounts) => ok({
        accounts: await collectCreditBalances(accounts, WORKBUDDY, endpointDeps(deps)),
        windowDays: buddyExpiringWindowDays(),
      }),
    },
    [CODEARTS_PROVIDER]: {
      // CodeArts 的可领状态要经 `statistics/plugin` + `/v1/ops/delivery` 两步才能得到，
      // 且与 CodeBuddy 的 CheckinStatus 不同构，故如实回 null。
      status: async (accounts) => ok(nullStatus(accounts)),
      // 领取流程自带「账户类型 + 活动列表」预检，故跳过外部状态查询 ——
      // 用 fetchCheckinStatus 打华为端点既发错请求又必然失败。
      claim: async (accounts) => ok(await collectClaimResults<CodeArtsCredential, undefined>(accounts, undefined, {
        ...endpointDeps(deps),
        claim: (credential) => claimCodeArtsDailyCheckin(credential),
        precheckStatus: false,
      })),
      balances: async (accounts) => ok({
        accounts: await collectCreditBalances<CodeArtsCredential, undefined>(accounts, undefined, {
          ...endpointDeps(deps),
          fetchBalanceDetailed: async (credential) => {
            const result = await fetchCodeArtsAccountInfoDetailed(credential)
            if (!result.ok) return { balance: null, error: `账户信息查询失败：${result.message}` }
            const info = result.info
            if (!info.isCreditPackage) {
              return {
                balance: null,
                error: info.isTokenPackage
                  ? 'Token 计费账户，无积分余额'
                  : '非积分计费账户，无积分余额',
              }
            }
            if (info.credit === undefined) return { balance: null, error: '未返回积分数据' }
            return { balance: info.credit }
          },
        }),
      }),
    },
    [LOBSTERAI.id]: {
      status: async (accounts) => ok(nullStatus(accounts)),
      // LobsterAI 的领取自身是多步的（slot → context → check_in），`claimedToday`
      // 与 `actions` 判断都在内部完成，故 precheckStatus: false。
      claim: async (accounts) => {
        const clientVersion = await deps.lobsterAiClientVersion()
        return ok(await collectClaimResults<LobsteraiCredential, typeof LOBSTERAI>(accounts, LOBSTERAI, {
          ...endpointDeps(deps),
          claim: (credential, product) => claimLobsteraiDailyCheckin(credential, product, clientVersion),
          precheckStatus: false,
        }))
      },
      balances: async (accounts) => ok({
        accounts: await collectCreditBalances<LobsteraiCredential, typeof LOBSTERAI>(accounts, LOBSTERAI, {
          ...endpointDeps(deps),
          fetchBalance: (credential, product) => fetchLobsteraiCreditBalance(credential, product),
        }),
        windowDays: creditExpiringWindowDays(),
      }),
    },
    [TRAE.id]: {
      status: async (accounts) => ok(nullStatus(accounts)),
      claim: async (accounts) => ok(await collectClaimResults<TraeCredential, undefined>(accounts, undefined, {
        ...endpointDeps(deps),
        fetchStatus: (credential) => fetchTraeCheckinStatus(credential as TraeCredential, TRAE, fetch),
        // ⚠️ **不传 `precheckStatus`（默认 true）是硬要求**：TRAE 的 claim 对「今天已领」
        // 不幂等，直接领取会被误报成 +积分。设备代次经账号池读写，命中 9074 才换代。
        claim: (credential, _product, entry) => claimTraeDailyCheckin(
          credential as TraeCredential,
          TRAE,
          fetch,
          deps.trae.generationFor(entry.id),
          (next) => deps.trae.updateGeneration(entry.id, next),
        ),
      })),
      balances: async (accounts) => ok({
        accounts: await collectCreditBalances<TraeCredential, typeof TRAE>(accounts, TRAE, {
          ...endpointDeps(deps),
          fetchBalance: (credential, product) => fetchTraeCreditBalance(credential, product),
        }),
        windowDays: creditExpiringWindowDays(),
      }),
    },
    [CLINE.id]: {
      // Cline **没有签到端点**（对整个 sidecar 二进制做字符串扫描，checkin /
      // check-in / daily / campaign 均无业务端点命中）。
      status: async (accounts) => ok(nullStatus(accounts)),
      claim: async () => unsupportedCheckin('Cline 不支持每日签到（其后端没有签到接口）'),
      balances: async (accounts) => ok({
        accounts: await collectAccountBalances(accounts, deps, async (credential: ClineCredential) => {
          const result = await fetchClineCreditBalance(credential, CLINE)
          return {
            balance: result.balance,
            ...result.balance === null ? { error: result.error ?? CREDITS_QUERY_FAILED } : {},
          }
        }),
      }),
    },
    [LOOMY.id]: {
      // Loomy 没有状态端点：每日额度由 `POST /points/first-login` 触发，幂等由
      // 领取接口自己处理（重复调用回 already-claimed）。
      status: async (accounts) => ok(nullStatus(accounts)),
      claim: async (accounts) => ok(await collectAccountOutcomes(accounts, deps, async (credential: LoomyCredential) =>
        [await deps.loomy.claimDailyQuota(credential)])),
      balances: async (accounts) => ok({
        accounts: await collectAccountBalances(accounts, deps, async (credential: LoomyCredential) => {
          const balance = await deps.loomy.fetchCreditBalance(credential)
          return { balance, ...balance === null ? { error: CREDITS_QUERY_FAILED } : {} }
        }),
      }),
    },
    [RACCOON.id]: {
      // ⚠️ 旧 `switch` 里 Racoon **没有** status 分支，落到 `productById` 兜底 ⇒
      // `unsupported provider: raccoon`。这里如实保持「缺动词」而非伪造一份 null 状态。
      claim: async () => unsupportedCheckin(
        'Raccoon Work 不支持每日签到（每日积分由服务端自动发放；登录奖励请在「新手任务」中领取）',
      ),
      balances: async (accounts) => ok({
        accounts: await collectAccountBalances(accounts, deps, async (credential: RaccoonCredential) => {
          const balance = await deps.raccoon.fetchCreditBalance(credential)
          return { balance, ...balance === null ? { error: CREDITS_QUERY_FAILED } : {} }
        }),
      }),
    },
    [MINIMAX.id]: {
      // ⚠️ 判据是 `is_today && status===3`（见 `minimaxPanelToCheckinStatus`），不是
      // 「没有 Claimable」；`active` 恒 true（拿到响应即 true）。
      status: async (accounts) => ok({
        accounts: await collectCreditsStatus<MinimaxCredential, undefined>(accounts, undefined, {
          ...endpointDeps(deps),
          fetchStatus: (credential) => fetchMinimaxSigninStatus(credential),
        }),
      }),
      // 默认 precheck：签到接口对「今天已领」回 already_claimed，可安全预检。
      claim: async (accounts) => ok(await collectClaimResults<MinimaxCredential, undefined>(accounts, undefined, {
        ...endpointDeps(deps),
        fetchStatus: (credential) => fetchMinimaxSigninStatus(credential),
        claim: (credential) => claimMinimaxDailyCheckin(credential),
      })),
      balances: async (accounts) => ok({
        accounts: await collectCreditBalances<MinimaxCredential, undefined>(accounts, undefined, {
          ...endpointDeps(deps),
          fetchBalance: (credential) => fetchMinimaxCreditBalance(credential),
        }),
      }),
    },
    [ZCODE.id]: {
      // zcode 没有「今日已领」端点，`claimDailyFor` 自带激活上报与 preview，
      // 重复调用只多发一次无谓请求，不值得为此加一次状态 GET。
      claim: async (accounts) => ok(await collectAccountOutcomes(accounts, deps, async (credential: ZcodeCredential) =>
        // captcha 一次性：`claimDailyWith` 解析一份配置后原样传回，region 与 param 必须同源
        // （阿里云成对验签，不一致即 400/3007）。
        await deps.zcode.claimDailyFor(credential, async (config) => await deps.zcode.mintCaptcha(config)))),
      balances: async (accounts) => ok({
        accounts: await collectAccountBalances(accounts, deps, async (credential: ZcodeCredential) => {
          const result = await deps.zcode.fetchBalanceFor(credential)
          if (result === undefined) return { balance: null, error: '额度查询失败（凭据失效或网络异常）' }
          if (result.enterprise === true) {
            return { balance: null, error: '企业版账号不下发额度数字，请在 ZCode 内查看' }
          }
          return { balance: buildZcodeBalance(result) }
        }),
      }),
    },
    [GEMINI.id]: {
      // 只有 Gemini 读 `req.force`（面板上的「刷新」要绕过宿主侧 TTL 缓存）。
      // 也是全仓库唯一用 `extra.accountTier` 的渠道。
      balances: async (accounts, request) => ok({
        accounts: await collectCreditBalances<GeminiCredential, typeof GEMINI>(accounts, GEMINI, {
          ...endpointDeps(deps),
          fetchBalanceDetailed: async (credential) => {
            const { balance, error, tier } = await fetchGeminiCreditBalance(credential, GEMINI, { force: request.force === true })
            const extra: RpcCreditsBalanceExtra | undefined = tier === undefined
              ? undefined
              : { accountTier: { label: tier.label, title: `${tier.name}（${tier.id}）` } }
            return {
              balance,
              ...error === undefined ? {} : { error },
              ...extra === undefined ? {} : { extra },
            }
          },
        }),
      }),
    },
    [OPENCODE.id]: {
      // 零网络：把账号池本地记录的限流状态映射成「可用通道数」，不查上游。
      balances: async (accounts) => ok({
        accounts: accounts.map((account) => {
          const now = Date.now()
          const limits = Object.entries(account.modelRateLimits ?? {})
          const limitedUntil = limits.reduce((max, [, resetAt]) => Math.max(max, Number(resetAt) || 0), 0)
          const limitedModels = limits.filter(([, resetAt]) => Number(resetAt) > now).length
          const available = account.enabled && limitedUntil <= now ? 1 : 0
          const balance: CreditBalance = {
            total: available,
            packages: [{
              name: limitedModels > 0 ? `${limitedModels} 个模型限额中` : '可用通道',
              unit: '通道',
              remaining: available,
              total: available,
              used: 0,
              active: true,
              cycleStartTime: '',
              cycleEndTime: '',
              expiredTime: '',
            }],
            expiredTotal: account.enabled && limitedUntil > now ? 1 : 0,
          }
          return {
            accountId: account.id,
            nickname: account.nickname,
            balance,
            ...(!account.enabled
              ? { error: '已停用' }
              : limitedUntil > now
                ? { error: `限额中，${new Date(limitedUntil).toLocaleString('zh-CN')} 恢复` }
                : {}),
          }
        }),
      }),
    },
    [QODER.id]: qoderChannel(deps, QODER),
    [QODER_CN.id]: qoderChannel(deps, QODER_CN),
  }
}
