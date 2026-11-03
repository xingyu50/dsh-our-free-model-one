/**
 * 换号的共享骨架：取下一个账号、换号预算、失败账号的标记记账。
 *
 * ## 为什么存在
 *
 * 十一家渠道在「一次请求内换号重试」上都写着同一段三行判据：
 *
 * ```ts
 * const next = await pool.getAvailableAccount(product.id, modelId, tried)
 * if (!next || tried.has(next.entry.id)) break
 * tried.add(next.entry.id)
 * ```
 *
 * 这段里有两条**必须同时成立**的不变量，漏一条换号就形同虚设：
 *
 * 1. `tried` 必须**传给池**（池按用户拖拽的手动顺序返回候选，刚失败的账号
 *    常常仍排第一；只在本地过滤等于拿回同一个账号后立刻放弃切换）；
 * 2. 拿到候选后还要**再查一次** `tried`（池的排除是过滤器，不是承诺）。
 *
 * 另有两条重复得同样普遍的记账不变量：**空账号 id 不标记**（`if (accountId.length
 * === 0) return`）与**同一账号只标记一次**（换号途中可能又取回它）。它们分别在
 * buddy / cline / gemini / qoder / zcode / codearts 各自的局部变量里各写一遍。
 *
 * 本模块只收这四条不变量，**不收**循环控制流与错误分类：哪些失败可换号、
 * 标记到什么时候（UTC+8 日界 / cline 报文解析 / 11140 内容拦截 5 分钟 /
 * gemini 两档冷却）、换号后要不要重签 uid 或重置端点 —— 这些是渠道特有的判据，
 * 留在各适配器里（见 `trae-selection.ts` / `cline-rate-limit.ts` 的先例）。
 *
 * @module account-rotation
 */
import type { AccountPool } from './account-pool.js'
import type { StoredTokenCredential } from './credential-expiry.js'

/** 池内启用账号数少于它时，仍按它给预算（`trae` 的既有下限）。 */
export const ROTATION_MIN_BUDGET = 3

/**
 * 本次请求最多尝试几个账号（**含首个账号**）。
 *
 * 无账号池（单凭据模式）时返回 1：没有号可换，不做无谓的重试。
 *
 * ⚠️ 只有 `trae` 用池大小做预算（`trae-adapter.ts` 的既有语义：多加几个号
 * 就该多试几个）。其余渠道是固定上限，**不要**拿这个函数去替换它们的常量 ——
 * 那会让「池里 10 个号」的 cline 从试 3 个变成试 10 个。
 */
export function poolRotationBudget(
  pool: AccountPool | undefined,
  provider: string,
  minimum: number = ROTATION_MIN_BUDGET,
): number {
  if (pool === undefined) return 1
  const enabled = pool.listAccountsByProvider(provider).filter(entry => entry.enabled).length
  return Math.max(minimum, enabled)
}

/** 换到手的下一个账号。 */
export interface RotatedAccount {
  /** 账号 id（写限流标记与账本回报都用它）。 */
  accountId: string
  /** 该账号的凭据（调用方按自己的渠道类型转换）。 */
  credential: StoredTokenCredential
}

/**
 * 从池里取下一个**未尝试过**的可用账号，并把它记入 `tried`。
 *
 * 返回 `undefined` 表示「没有下一个了」：没有池、池里没有可用账号、
 * 或池给出的候选已经在 `tried` 里。三种原因对调用方是同一件事 ——
 * 用户能做的动作完全一样（等解禁或加号）。
 */
export async function pickNextAccount(options: {
  /** 账号池；单凭据模式为 `undefined`。 */
  pool: AccountPool | undefined
  /** 渠道 id（必须是 `product.id`，不要写死字面量）。 */
  provider: string
  /** 目标模型；空串表示不按模型过滤限流（会让限流过滤整体短路）。 */
  modelId: string
  /** 已尝试过的账号 id；命中的候选会被跳过并**就地记入**。 */
  tried: Set<string>
}): Promise<RotatedAccount | undefined> {
  const { pool, provider, modelId, tried } = options
  if (pool === undefined) return undefined
  const next = await pool.getAvailableAccount(provider, modelId, tried)
  if (next === null || next === undefined) return undefined
  if (tried.has(next.entry.id)) return undefined
  tried.add(next.entry.id)
  return { accountId: next.entry.id, credential: next.credential }
}

/** 「这个账号的失败已经记过账了」的登记簿。 */
export interface MarkRegistry {
  /**
   * 该账号是否**第一次**被标记。
   *
   * 返回 `true` 才去执行真正的标记动作（写 `modelRateLimits`、留徽章）；
   * 空账号 id 与重复 id 一律返回 `false`。
   */
  claim(accountId: string): boolean
}

/**
 * 新建一份标记登记簿。
 *
 * 一个登记簿对应**一次请求**（跨换号保留），不要在每个循环迭代里新建 ——
 * 那等于没有去重。
 */
export function createMarkRegistry(): MarkRegistry {
  const marked = new Set<string>()
  return {
    claim(accountId: string): boolean {
      if (accountId.length === 0) return false
      if (marked.has(accountId)) return false
      marked.add(accountId)
      return true
    },
  }
}
