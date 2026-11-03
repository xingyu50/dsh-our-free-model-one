/**
 * 「UTC+8 日界」的唯一一份算术。
 *
 * 各渠道的每日额度（签到、限流解禁、账本按天分桶）都由**服务端**按 UTC+8 换日，
 * 不跟本机闹钟走。此前这条纪律被抄成四份、散在四个模块里 —— model-queue 的
 * `nextUtc8DayStartMs`、auto-checkin 的 `utc8DateString` / `utc8MsIntoDay`、
 * token-ledger 的 `utc8DayKey`，以及 qoder-credits 里一段 inline 的 `new Date(+offset)`。
 * 它们靠 {@link} 注释互相提醒「口径要一致」，改一处就会漏一处。收在这里以后只有一处会算错。
 *
 * ⚠️ 一律用**算术平移**，不用 `Date.setHours` / `getHours` / `Intl`：前者按本机时区
 * 运算（用户出差或改系统时区就得到错的日界），后者的行为依赖时区数据库版本。需求是
 * 「固定的 UTC+8」，写死偏移量最可预测、也便于单测。
 */

/** 一天的毫秒数。取模与「距日界偏移」都围着它转。 */
export const MS_PER_DAY = 86_400_000

/** UTC+8 相对 UTC 的偏移（毫秒）。 */
export const QODER_BILLING_UTC_OFFSET_MS = 8 * 3_600_000

/**
 * 「今天（UTC+8）已经过去多少毫秒」—— 即距当日 00:00 的偏移量。
 *
 * 偏移量恒在 `[0, MS_PER_DAY)`：时间戳可以是负数（1970 年之前），而 JS 的 `%`
 * 对负数返回负余数，故取模后要补一次正。
 */
export function utc8MsIntoDay(nowMs: number = Date.now()): number {
  const shifted = nowMs + QODER_BILLING_UTC_OFFSET_MS
  return ((shifted % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY
}

/**
 * 「UTC+8 当日已经过去多少**分钟**」（0–1439）。
 *
 * 促销时段（`22:00–08:00` 这类 HH:MM 窗口）按分钟比较，故把偏移换算成分。
 * 与 `new Date(ts + 偏移).getUTCHours()*60 + getUTCMinutes()` 恒等。
 */
export function utc8MinutesOfDay(nowMs: number = Date.now()): number {
  return Math.floor(utc8MsIntoDay(nowMs) / 60_000)
}

/**
 * 取「UTC+8 的当天日期」（`YYYY-MM-DD`）。
 *
 * 用于「这一轮跑的是哪一天」这类比较（自动签到的 `lastDate`）。等价于把时间戳
 * 平移到 UTC+8 的墙上时间再取 UTC 日期部分。
 */
export function utc8DateString(nowMs: number = Date.now()): string {
  return new Date(nowMs + QODER_BILLING_UTC_OFFSET_MS).toISOString().slice(0, 10)
}

/**
 * 算出「**UTC+8 的当日 24:00**」对应的 UTC 毫秒时间戳。
 *
 * 语义：额度按**自然日**重置，故受限时间取「今天（UTC+8）结束的那一刻」——
 * 即次日 00:00:00.000（UTC+8）。
 *
 * @param nowMs - 当前 UTC 毫秒时间戳（注入以便单测；默认 `Date.now()`）。
 * @returns UTC+8 次日 00:00 的 UTC 毫秒时间戳（**严格大于** `nowMs`）。
 */
export function nextUtc8DayStartMs(nowMs: number = Date.now()): number {
  const msIntoDay = utc8MsIntoDay(nowMs)
  return nowMs + (MS_PER_DAY - msIntoDay)
}

/**
 * **UTC+8 日键**（`YYYY-MM-DD`），账本按天分桶用。
 *
 * 与 {@link utc8DateString} 同口径，但直接从平移后的日期对象上取年月日再补零 ——
 * 账本键是落盘的历史数据，格式不能随实现改动（`toISOString` 依赖 UTC 取值，
 * 这里的 `getUTC*` 同理，两者结果必须一致）。
 */
export function utc8DayKey(ts: number): string {
  const shifted = new Date(ts + QODER_BILLING_UTC_OFFSET_MS)
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const day = String(shifted.getUTCDate()).padStart(2, '0')
  return `${shifted.getUTCFullYear()}-${month}-${day}`
}

/**
 * 日键 → 该日 UTC+8 00:00 的 UTC 毫秒时间戳（{@link utc8DayKey} 的反向）。
 *
 * 落盘数据只存日键、不存时刻，淘汰旧日桶时要把它还原成时刻才能比较。
 * 日键格式非法时返回 `Number.NaN`（调用方按「无法判定」处理）。
 */
export function utc8DayKeyStartMs(day: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return Number.NaN
  const parsed = Date.parse(`${day}T00:00:00Z`)
  return Number.isFinite(parsed) ? parsed - QODER_BILLING_UTC_OFFSET_MS : Number.NaN
}
