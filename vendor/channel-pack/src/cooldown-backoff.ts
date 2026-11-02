/**
 * 连续失败 → 指数冷却的**纯计算**。
 *
 * ## 为什么单独成文件
 *
 * 同一条公式此前只存在于 `captcha-backoff.ts` 的 `noteFailure()` 里。
 * trae 的选号冷却需要**完全相同**的增长曲线（阈值那次用 `baseMs`，之后每次
 * 翻倍直到 `maxMs`），如果各写一份，两份迟早分叉 —— 而这类分叉的表现是
 * 「同一个账号在两条链路上冷却时长不一致」，排查时极难归因。
 *
 * 这里只保留**算式**，不持有状态：状态（连续失败计数、冷却截止时刻）
 * 由各自的调用方持有 —— `CaptchaBackoff` 持有自己的，trae 的选号账本
 * 持有按 (账号, 模型) 分开的一份。
 *
 * ## 语义
 *
 * `streak` 是**连续**失败次数（成功即清零，由调用方负责）。返回本次应进入的
 * 冷却时长（毫秒）：
 *
 * - 未达阈值 → `0`（**不冷却**，这正是「失败一两次不算数」的落点）
 * - 达到阈值的那次 → `baseMs`
 * - 之后每多一次失败翻倍，封顶 `maxMs`
 *
 * ⚠️ 用 `streak - threshold`（而不是 `streak`）指数：否则第 3 次失败就会
 * 直接等到 `base × 8`，首次冷却反而最久 —— 与「起步 5 分钟」的语义相反。
 */

/** 冷却策略。 */
export interface CooldownPolicy {
  /** 连续失败达几次才进入冷却。 */
  readonly threshold: number
  /** 首次冷却时长（毫秒）。 */
  readonly baseMs: number
  /** 冷却时长上限（毫秒）。 */
  readonly maxMs: number
}

/**
 * 默认策略：连续 3 次失败才冷却，起步 5 分钟，之后 10 / 20 / 30 分钟封顶。
 *
 * 与 `captcha-backoff.ts` 的默认值**刻意不同**（那边是 3 次 / 1 分钟 / 30 分钟）：
 * captcha 是设备级、失败一次就可能让整台机器停摆一分钟以上，起步要短；
 * trae 的失败是**按账号按模型**的，一次失败通常只说明这个号此刻不行，
 * 起步太短会让「换个号继续」变成「等 1 分钟再试」。
 */
export const DEFAULT_COOLDOWN_POLICY: CooldownPolicy = Object.freeze({
  threshold: 3,
  baseMs: 300_000,
  maxMs: 1_800_000,
})

/**
 * 连续失败 `streak` 次时本次应进入的冷却时长（毫秒）；`0` = 不冷却。
 *
 * @param streak - **连续**失败次数（1 = 本次是连续第 1 次失败）
 * @param policy - 阈值与时长；默认 {@link DEFAULT_COOLDOWN_POLICY}
 */
export function exponentialCooldownMs(
  streak: number,
  policy: CooldownPolicy = DEFAULT_COOLDOWN_POLICY,
): number {
  if (!Number.isFinite(streak) || streak < policy.threshold) return 0
  const steps = Math.max(0, Math.trunc(streak) - policy.threshold)
  return Math.min(policy.baseMs * 2 ** steps, policy.maxMs)
}
