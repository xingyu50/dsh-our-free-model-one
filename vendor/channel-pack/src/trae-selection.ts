/**
 * TRAE 的选号策略：**轮转** + **紧急插队** + **失败计数冷却**。
 *
 * ## 它解决什么
 *
 * 截至本次改动，trae 的选号完全交给 `AccountPool.getAvailableAccount` ——
 * 而那个方法的候选顺序**恒为用户拖拽设定的手动顺序**，实现里没有任何排序
 * （见 `account-pool.ts` 的 `getAvailableAccount`）。于是：
 *
 * - **平时不轮转**：只要 1 号账号健康，它就被每一次请求选中，2 号以后永远闲着。
 *   用户 4 个账号只有 1 个在干活（buddy 侧同样存在这个问题，但 buddy 至少有
 *   「快到期积分优先」让排序随时间自然漂移，trae 什么都没有）。
 * - **坏号永远排第一**：`shouldRotateTraeAccount` 对 `server` / `client` /
 *   `session-dead` 也返回 true，但 `recordsTraeRateLimit` 对这三类**不写标记**。
 *   于是「换号了、但没留痕迹」—— 下一轮请求仍从同一个坏号开始，白烧换号预算。
 * - **一次失败就冷却一小时**：`TRAE_RATE_LIMIT_FALLBACK_MS = 3_600_000` 且
 *   从不解析服务端真实重置时刻，一次抖动就把好号锁死一小时。
 *
 * 本模块把这三件事各自拆成可单测的纯逻辑。
 *
 * ## 三条决策（用户拍板，勿擅自改回）
 *
 * 1. **平时等权轮转，只有紧急才插队**。严格按到期时间排序会让「最急的那个号」
 *    永远排第一 —— buddy 现在就是这样，「均衡分流」名存实亡。故轮转是常态；
 *    只有当某号的积分**三天内作废**、或**剩余天数不到另一个账号的一半**时，
 *    才允许它插到队头用掉。
 * 2. **只有付费模型才查余额**。免费模型（`creditsRate === 0`）不消耗积分，
 *    查余额纯属浪费 N 次 HTTP（trae 没有批量端点，见 `trae-credits.ts`）。
 * 3. **轮转游标只存内存**。零文件改动，不碰 `sanitizeAccounts` 与备份格式；
 *    重启后从头开始，对用户无可感知差异。
 *
 * ## 与 buddy 的关系
 *
 * buddy 的 `buddy-balance-rank.ts` 做的是**三档排序**（快到期 / 永久 / 无），
 * 排序键是「这一档里有没有可用积分」。trae 不需要那个档位：它只需要一个
 * **标量** —— 该账号最早的作废时刻（{@link earliestDeductionEndMs}），用来判断
 * 「要不要插队」。所以这里没有复用 buddy 的纯函数，只借用了同一份
 * `CreditBalance` 契约（`fetchTraeCreditBalance` 产出的正是那个类型）。
 *
 * **明确不照搬**的是 buddy 的「档内严格保持手动顺序」：那正是「没有轮转」的
 * 出处（buddy 的 1 号号只要健康就永远第一）。这里改用游标。
 */

import type { TraeCredential } from './trae.js'
import type { CreditBalance } from './credits.js'
import { fetchTraeCreditBalance } from './trae-credits.js'
import { TRAE } from './trae-product.js'
import type { TraeErrorKind } from './trae-errors.js'
import { isModelSaturationError } from './llm-adapter.js'
import { DEFAULT_COOLDOWN_POLICY, exponentialCooldownMs, type CooldownPolicy } from './cooldown-backoff.js'

/** 余额缓存 TTL（毫秒）。与 buddy / loomy 同值。 */
export const TRAE_BALANCE_CACHE_TTL_MS = 60_000

/**
 * **失败**余额查询的缓存 TTL（毫秒），比成功短一个数量级。
 *
 * 失败是瞬时状态（网络抖动、凭据正在续期），缓存满 60 秒会让一次抖动伪装成
 * 「这个号没钱」整整一分钟 —— 与 buddy 那份同一修复。
 */
export const TRAE_BALANCE_ERROR_CACHE_TTL_MS = 5_000

/**
 * 「快作废」判定窗口（毫秒）：3 天。
 *
 * 与 buddy 的 15 天**刻意不同**（用户要求「按实际情况」）：15 天是为了把
 * 腾讯那套「到期即清零」的积分赶在作废前用掉，而 trae 的资源包周期更长、
 * 单包额度更小，3 天足以覆盖一次完整的对话量，又不会让一个长期账号
 * 仅仅因为「下个月到期」就天天插队。
 */
export const TRAE_URGENT_WINDOW_MS = 3 * 24 * 60 * 60 * 1000

/** 一条待选账号（调用方从账号池取出，顺序即手动优先级）。 */
export interface TraeCandidateAccount {
  id: string
  credentialRef: string
}

/** 选号依赖（便于单测注入）。 */
export interface TraeSelectionDeps {
  /** 解析某账号的凭据；返回 undefined 表示不可用。 */
  resolveCredential: (credentialRef: string) => Promise<TraeCredential | undefined>
  /** 查询余额（默认真实的 `fetchTraeCreditBalance`；单测注入桩）。 */
  fetchBalance?: (credential: TraeCredential) => Promise<CreditBalance | null>
  /** 当前时间（测试用）。 */
  now?: () => number
  /** TTL 覆盖（测试用）。 */
  ttlMs?: number
  /** 失败结果 TTL 覆盖（测试用）。 */
  errorTtlMs?: number
  /** 快作废窗口覆盖（测试用）。 */
  urgentWindowMs?: number
}

/** 一次余额查询的原料（缓存这个，分类每次现算）。 */
type BalanceSource = { ok: true; balance: CreditBalance } | { ok: false; error: string }

/** 选中的账号与凭据。 */
export interface TraeSelection {
  accountId: string
  credential: TraeCredential
}

/**
 * 从 `CreditBalance` 取「最早作废时刻」（毫秒）；没有可用积分包时返回 `undefined`。
 *
 * ⚠️ **只看 `deductionEndTime`**，不看 `expiredTime`：后者在包还有效时一律为空串，
 * 只在包真正失效后由服务端回填（见 `credits.ts` 的 `CreditPackage` 注释）。
 * 缺 `deductionEndTime` = 「服务端未下发到期时间」，按「不会作废」处理 ——
 * 与 `splitBuddyCreditsByExpiry` 的保守方向一致（宁可少插队，也不误插队）。
 */
export function earliestDeductionEndMs(balance: CreditBalance | null | undefined): number | undefined {
  if (balance === null || balance === undefined) return undefined
  let earliest: number | undefined
  for (const pkg of balance.packages) {
    if (pkg.active !== true) continue
    if (!(pkg.remaining > 0)) continue
    const end = pkg.deductionEndTime
    if (typeof end !== 'number' || !Number.isFinite(end) || end <= 0) continue
    earliest = earliest === undefined ? end : Math.min(earliest, end)
  }
  return earliest
}

/**
 * 判定某账号是否「紧急」，需要在轮转之外插队。
 *
 * 两条充分条件（满足其一即可）：
 *
 * 1. 最早作废时刻距今不足 {@link TRAE_URGENT_WINDOW_MS}；
 * 2. 剩余时间不到**另一个**账号的一半 —— 即「存在某个号还能用我的两倍以上时间」。
 *    这条让插队不必等到最后三天：若一批积分明早作废、另一批还能用一个月，
 *    那它现在就该被优先烧掉。
 *
 * ⚠️ 条件 2 是**存在量词**（`some`），不是「比所有号都短」。用全称量词的话，
 * 只有最短命的那个号紧急，而此时它已经是最短的，轮转本就几乎不会轮到别人。
 * 存在量词的语义是「我的寿命明显短于池内的主流」，正是「快作废」的本意。
 *
 * 拿不到到期时间的账号**永不紧急**（`undefined` 不参与比较）。
 */
export function isUrgentExpiry(
  ownEndMs: number | undefined,
  otherEndMs: readonly (number | undefined)[],
  now: number,
  windowMs: number = TRAE_URGENT_WINDOW_MS,
): boolean {
  if (ownEndMs === undefined) return false
  if (ownEndMs - now < windowMs) return true
  const ownRemaining = ownEndMs - now
  return otherEndMs.some(other => other !== undefined && (other - now) > ownRemaining * 2)
}

/**
 * 把候选排成「本次应当依次尝试」的顺序。
 *
 * 纯函数，不含 IO —— 顺序规则全部可单测：
 *
 * 1. 基础顺序 = 候选传入顺序（手动拖拽顺序）；
 * 2. **从前一个被选中的账号之后继续**（轮转，环绕一圈）；
 * 3. 若有账号紧急，把**最急的那一个**提到队头；
 * 4. 其余保持「轮转后」的相对顺序 —— 紧急号之外仍然等权。
 *
 * @param candidates - 已按 enabled 与模型限流过滤过的候选
 * @param cursorAccountId - 上一次选中的账号 id；空串或不在候选里 = 从头开始
 * @param ends - 每个候选的最早作废时刻（`Map<账号 id, 毫秒>`）；免费模型传空表
 * @param now - 当前时刻（毫秒）
 * @param urgentWindowMs - 快作废窗口
 */
export function orderTraeCandidates<T extends TraeCandidateAccount>(
  candidates: readonly T[],
  cursorAccountId: string,
  ends: ReadonlyMap<string, number>,
  now: number,
  urgentWindowMs: number = TRAE_URGENT_WINDOW_MS,
): T[] {
  if (candidates.length <= 1) return [...candidates]

  const startIndex = cursorAccountId.length === 0
    ? 0
    : (() => {
        const found = candidates.findIndex(candidate => candidate.id === cursorAccountId)
        // 游标指向的账号已被删除/停用 → 从头开始，而不是跳过一圈。
        return found < 0 ? 0 : (found + 1) % candidates.length
      })()

  // 环绕展开，保持手动顺序的相对关系。
  const rotated = candidates.map((_, offset) => candidates[(startIndex + offset) % candidates.length]!)

  let urgentId: string | undefined
  let urgentEnd = Number.POSITIVE_INFINITY
  const allEnds = candidates.map(candidate => ends.get(candidate.id))
  for (const candidate of candidates) {
    const ownEnd = ends.get(candidate.id)
    if (!isUrgentExpiry(ownEnd, allEnds.filter(end => end !== ownEnd), now, urgentWindowMs)) continue
    if (ownEnd !== undefined && ownEnd < urgentEnd) {
      urgentEnd = ownEnd
      urgentId = candidate.id
    }
  }
  if (urgentId === undefined) return rotated

  const urgent = rotated.find(candidate => candidate.id === urgentId)!
  return [urgent, ...rotated.filter(candidate => candidate.id !== urgentId)]
}

/**
 * 余额缓存 + 轮转选号器。
 *
 * 每个 provider 一个实例（与 `BuddyBalanceSelector` 同构），故缓存不会串味。
 */
export class TraeAccountSelector {
  private readonly cache = new Map<string, CacheEntry>()
  /** 轮转游标：模型 → 上一次选中的账号 id（**只在内存**，重启即清）。 */
  private readonly cursor = new Map<string, string>()

  constructor(private readonly deps: TraeSelectionDeps) {}

  /** 清空余额缓存（凭据变化、手动刷新余额后调用）。 */
  invalidate(accountId?: string): void {
    if (accountId === undefined) this.cache.clear()
    else this.cache.delete(accountId)
  }

  /** 当前轮转游标（诊断用；测试据此断言「下一个是谁」）。 */
  cursorOf(modelId: string): string {
    return this.cursor.get(modelId) ?? ''
  }

  /** 清空轮转游标（测试用；生产入口不调）。 */
  resetCursor(): void {
    this.cursor.clear()
  }

  /** 查一个账号的余额原料（命中缓存时直接用，失败用更短的 TTL）。 */
  private async balanceOf(account: TraeCandidateAccount): Promise<BalanceSource> {
    const now = this.deps.now?.() ?? Date.now()
    const cached = this.cache.get(account.id)
    if (cached !== undefined) {
      const ttl = cached.source.ok
        ? (this.deps.ttlMs ?? TRAE_BALANCE_CACHE_TTL_MS)
        : (this.deps.errorTtlMs ?? TRAE_BALANCE_ERROR_CACHE_TTL_MS)
      if (now - cached.at < ttl) return cached.source
    }
    const source = await this.fetchSource(account)
    this.cache.set(account.id, { at: now, source })
    return source
  }

  /** 发一次余额请求；**永不抛错**（失败转成 `{ ok: false }`）。 */
  private async fetchSource(account: TraeCandidateAccount): Promise<BalanceSource> {
    let credential: TraeCredential | undefined
    try {
      credential = await this.deps.resolveCredential(account.credentialRef)
    } catch (error) {
      return { ok: false, error: `读取凭据失败：${error instanceof Error ? error.message : String(error)}` }
    }
    if (credential === undefined) return { ok: false, error: '凭据未配置或已失效' }
    try {
      const balance = await (this.deps.fetchBalance
        ?? ((cred) => fetchTraeCreditBalance(cred, TRAE)))(credential)
      if (balance === null) return { ok: false, error: '余额查询失败（凭据失效或响应异常）' }
      return { ok: true, balance }
    } catch (error) {
      return { ok: false, error: `余额查询异常：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /**
   * 选出本次要用的账号。
   *
   * ## 串行查余额（**不要改成并发**）
   *
   * 面板侧的 `collectCreditBalances` 明确用 `for (const entry of accounts)`
   * 串行查询，注释写着「顺序查询，避免并发触发风控」（见
   * `channel-pack-rpc.ts`）。这里是同一批端点、同一台机器、同一个凭据族，
   * 并发打过去有踩风控的风险。60 秒缓存保证这只在首轮或缓存过期时发生。
   *
   * ## 免费模型不查余额
   *
   * `freeModel === true` 直接走纯轮转（零额外请求）。判据由调用方给
   * （`TraeAdapter.isFreeModel` 读远端 `creditsRate === 0`）。
   *
   * ## 查不到余额不影响可用性
   *
   * 与 buddy 的「锁定永久积分」不同，trae 没有「禁止消耗某一类积分」的开关
   * （`PERMANENT_LOCK_PROVIDERS` 不含 trae）。故余额只用来**排序**，
   * 一条都查不到时退回纯轮转 —— 绝不因为「查不到」而报告「无可用账号」。
   *
   * @param modelId - 目标模型（限流与游标都按模型分账）
   * @param candidates - 已过滤的候选（顺序即手动优先级）
   * @param freeModel - 是否免费模型（true 则跳过余额查询）
   * @returns 选中的账号与凭据；全部候选凭据不可解析时返回 `undefined`
   */
  async select(
    modelId: string,
    candidates: readonly TraeCandidateAccount[],
    freeModel: boolean,
  ): Promise<TraeSelection | undefined> {
    if (candidates.length === 0) return undefined

    const now = this.deps.now?.() ?? Date.now()
    const ends = new Map<string, number>()
    if (!freeModel) {
      // 串行查询（见方法注释）。免费模型整段跳过。
      for (const candidate of candidates) {
        const source = await this.balanceOf(candidate)
        if (!source.ok) continue
        const end = earliestDeductionEndMs(source.balance)
        if (end !== undefined) ends.set(candidate.id, end)
      }
    }

    const ordered = orderTraeCandidates(
      candidates,
      this.cursor.get(modelId) ?? '',
      ends,
      now,
      this.deps.urgentWindowMs ?? TRAE_URGENT_WINDOW_MS,
    )

    for (const candidate of ordered) {
      let credential: TraeCredential | undefined
      try {
        credential = await this.deps.resolveCredential(candidate.credentialRef)
      } catch {
        continue
      }
      if (credential === undefined || credential.access_token.length === 0) continue
      this.cursor.set(modelId, candidate.id)
      return { accountId: candidate.id, credential }
    }
    return undefined
  }
}

/** 一个账号的缓存条目：`at` 是网络请求时刻（只用于 TTL）。 */
interface CacheEntry {
  at: number
  source: BalanceSource
}

/**
 * 一次请求的结果，供失败账本判定「该不该计数」。
 *
 * `body` 必须传**响应体原文**：模型繁忙的判据（`isModelSaturationError`）
 * 只能从响应体读出来，只看状态码会把「模型繁忙」的 429 当成账号限流。
 */
export interface TraeCallOutcome {
  kind: TraeErrorKind
  status: number
  body: string
}

/**
 * 失败账本：**连续失败达阈值才冷却**，按 (账号, 模型) 分账。
 *
 * ## 为什么需要「连续」
 *
 * 现行做法（`recordsTraeRateLimit` 命中就写 1 小时标记）一次失败即判死刑 ——
 * 用户的原话是「不要一次就冷却，要有一个量才会」。故这里前两次失败**什么都不写**，
 * 第三次才落标记 5 分钟，之后 10 / 20 / 30 分钟封顶。
 *
 * ## 计数落在哪
 *
 * 复用池的 `modelRateLimits`（用户拍板的落点）：不新增持久化字段，
 * 面板的「限额重置」徽章、重测/重置按钮、重启后仍在冷却全部继续有效。
 * 代价是 UI 上分不出「安全策略拦截」与「额度限流」—— 与 buddy 的
 * `markPolicyBlockedAccount` 同一取舍，那边也已接受。
 *
 * ## 哪些失败计数
 *
 * | 类别 | 计数 | 理由 |
 * | --- | --- | --- |
 * | `session-dead`（401/403） | ✅ | 这个号的登录态坏了，换号才对 |
 * | `soft-rate`（429 / 4011） | ✅ | 明确的账号级限流 |
 * | `hard-plan`（1005） | ✅ | 该号的套餐权益不足 |
 * | `quota-exceeded`（4008） | ✅ | 该号积分耗尽 |
 * | `not-found`（404） | ✅ | 账号在服务端已不存在，换号才有救 |
 * | `server`（5xx） | ❌ | **上游抽风不该惩罚好号**，否则一次故障全网冷却 |
 * | `client`（其余 4xx） | ❌ | 通常是请求本身有问题，换号无意义且会连坐 |
 * | 模型繁忙（`isModelSaturationError`） | ❌ | 是**模型**忙，不是账号的问题；buddy 侧同样只在本账号退避、不换号 |
 */
export function countsAsTraeFailure(outcome: TraeCallOutcome): boolean {
  // 先判模型繁忙：它可能以 429 或 5xx 下发，若不先拦下会被误记成账号限流。
  if (isModelSaturationError(outcome.status, outcome.body)) return false
  switch (outcome.kind) {
    case 'session-dead':
    case 'soft-rate':
    case 'hard-plan':
    case 'quota-exceeded':
    case 'not-found':
      return true
    case 'server':
    case 'client':
    case 'none':
      return false
  }
}

/** 失败账本的依赖。 */
export interface TraeFailureLedgerDeps {
  /** 写限流标记（复用池的 `updateModelRateLimit`）。 */
  updateModelRateLimit: (accountId: string, modelId: string, resetAtMs: number) => Promise<void>
  /** 当前时间（测试用）。 */
  now?: () => number
  /** 冷却策略覆盖（测试用）。 */
  policy?: CooldownPolicy
}

/** `(账号, 模型)` 复合键的分隔符。`\u0000` 不可能出现在账号 id 或模型 id 里。 */
const LEDGER_SEPARATOR = '\u0000'

/**
 * 连续失败账本。
 *
 * 状态全在**进程内存**：重启归零。这与「轮转游标只存内存」是同一取舍 ——
 * 真正的冷却落在 `modelRateLimits`（持久化），账本只是「攒到阈值」的计数器，
 * 重启后从 0 数起是可以接受的偏差（最多多给一次机会，不会多惩罚）。
 */
export class TraeFailureLedger {
  private readonly streaks = new Map<string, number>()
  private readonly policy: CooldownPolicy

  constructor(private readonly deps: TraeFailureLedgerDeps) {
    this.policy = deps.policy ?? DEFAULT_COOLDOWN_POLICY
  }

  private key(accountId: string, modelId: string): string {
    return `${accountId}${LEDGER_SEPARATOR}${modelId}`
  }

  /** 当前连续失败次数（诊断与测试用）。 */
  streakOf(accountId: string, modelId: string): number {
    return this.streaks.get(this.key(accountId, modelId)) ?? 0
  }

  /** 记一次成功：清零该 (账号, 模型) 的连续失败计数。 */
  noteSuccess(accountId: string, modelId: string): void {
    if (accountId.length === 0) return
    this.streaks.delete(this.key(accountId, modelId))
  }

  /**
   * 记一次失败；返回**本次写入的冷却截止时刻**（`0` = 未达阈值、未写标记）。
   *
   * 不计数的那几类（5xx / client / 模型繁忙）直接返回 0 且**不影响 streak** ——
   * 既不加一也不清零：上游抖一下不该让「差一次就到阈值」重新从头数。
   *
   * ⚠️ `updateModelRateLimit` 只接受**更长**的解禁时刻（`account-pool.ts` 的
   * 「只接受比现值更大」约定）。指数增长天然满足；但若某个标记比本次算出的
   * 阈值还长（例如上游给过 1 小时），本次写入会被它挡住 —— 那是正确行为。
   */
  async noteFailure(accountId: string, modelId: string, outcome: TraeCallOutcome): Promise<number> {
    if (accountId.length === 0) return 0
    if (!countsAsTraeFailure(outcome)) return 0
    const key = this.key(accountId, modelId)
    const streak = (this.streaks.get(key) ?? 0) + 1
    this.streaks.set(key, streak)
    const cooldownMs = exponentialCooldownMs(streak, this.policy)
    if (cooldownMs === 0) return 0
    const untilMs = (this.deps.now?.() ?? Date.now()) + cooldownMs
    try {
      await this.deps.updateModelRateLimit(accountId, modelId, untilMs)
    } catch {
      // 写标记失败不该让请求失败：冷却只是优化，请求本身仍要继续换号。
      return 0
    }
    return untilMs
  }
}
