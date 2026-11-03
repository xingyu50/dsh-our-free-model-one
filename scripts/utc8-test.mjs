/**
 * UTC+8 日界算术的公共接缝测试。
 *
 * 期望值全部是**手算的**时刻（UTC 时间戳 ↔ UTC+8 墙上时间是 +8 小时的平移），
 * 不从被测实现里推导 —— 否则「同一算式抄两遍」也会绿。
 *
 * 这组断言的作用是：把四份分散的日界算术（model-queue / auto-checkin / token-ledger /
 * qoder-credits）收进 utc8.ts 时，先钉死「收拢前后对外行为一致」。
 */
import assert from 'node:assert/strict'
import { importChannelSource, installChannelSource } from './lib/channel-source.mjs'

installChannelSource()

const utc8 = await importChannelSource('utc8.ts')
const modelQueue = await importChannelSource('model-queue.ts')
const autoCheckin = await importChannelSource('auto-checkin.ts')
const tokenLedger = await importChannelSource('token-ledger.ts')

const DAY = 86_400_000
let checks = 0
const ok = (label) => { checks++; console.log('ok  ' + label) }

/** 2026-10-28T00:00:00.000+08:00 恰好是 UTC 的 10-27T16:00Z。 */
const DAY_START = Date.UTC(2026, 9, 27, 16, 0, 0, 0)

assert.equal(utc8.utc8DateString(DAY_START), '2026-10-28', 'UTC+8 日界那一刻属于新的一天')
assert.equal(utc8.utc8DateString(DAY_START - 1), '2026-10-27', '日界前一毫秒仍属于前一天')
assert.equal(modelQueue.nextUtc8DayStartMs(DAY_START - 1), DAY_START, '前一天最后一毫秒的下一日界就是 DAY_START')
assert.equal(utc8.nextUtc8DayStartMs(DAY_START), DAY_START + DAY, '已站在日界上时取下一个日界，严格大于入参')
assert.equal(utc8.utc8MsIntoDay(DAY_START), 0, '日界那一刻当天过去 0 毫秒')
assert.equal(utc8.utc8MsIntoDay(DAY_START - 1), DAY - 1, '前一天的最后一毫秒')
ok('日界：日期字符串 / 距日界偏移 / 下一日界三个口径互相对齐')

/** 日界后 30 分钟：自动签到那段窗口判据依赖这个值。 */
assert.equal(utc8.utc8MsIntoDay(DAY_START + 30 * 60_000), 1_800_000, '日界 +30 分钟')
assert.equal(utc8.utc8DateString(DAY_START + 30 * 60_000), '2026-10-28', '窗口仍算当天')
ok('日界 +30 分钟落在 1800000 毫秒，仍在同一天')

/** 1970 年之前：这里才是「取模 + 补正」那段代码真正起作用的地方。 */
const before = Date.UTC(1969, 11, 31, 5, 0, 0, 0)
assert.equal(utc8.utc8MsIntoDay(before), 46_800_000, '负时间戳平移到 13:00，不能得到负的偏移')
assert.equal(utc8.utc8DateString(before), '1969-12-31', '负时间戳的 UTC+8 日期')
ok('1970 年之前的负时间戳仍得到正的「距日界偏移」')

/** 账本日键：token-ledger.json 里已存的键是历史数据，格式不能变。 */
assert.equal(utc8.utc8DayKey(DAY_START), '2026-10-28', '日键与 utc8DateString 同口径')
assert.equal(utc8.utc8DayKey(DAY_START - 1), '2026-10-27', '日键跨日界')
assert.equal(utc8.utc8DayKey(before), '1969-12-31', '负时间戳的日键，月与日都要补零')
assert.equal(utc8.utc8DayKey(Date.UTC(2026, 0, 9, 16, 0, 0, 0)), '2026-01-10', '一位数月份补零')
ok('日键补零、跨日界、负时间戳三种情形都与日期字符串一致')

/** 收拢的契约：旧模块仍导出同一个函数，13 个 import 点不用改。 */
assert.equal(typeof modelQueue.nextUtc8DayStartMs, 'function', 'model-queue.ts 仍导出 nextUtc8DayStartMs')
assert.equal(modelQueue.nextUtc8DayStartMs, utc8.nextUtc8DayStartMs, 'model-queue.ts 的导出就是 utc8.ts 那一个，不是第二份实现')
assert.equal(autoCheckin.utc8DateString, utc8.utc8DateString, 'auto-checkin.ts re-export 同一个函数')
assert.equal(autoCheckin.utc8MsIntoDay, utc8.utc8MsIntoDay, 'auto-checkin.ts 的日界偏移也是同一个函数')
assert.equal(tokenLedger.utc8DayKey, utc8.utc8DayKey, 'token-ledger.ts 的日键是同一个函数')
assert.equal(modelQueue.QODER_BILLING_UTC_OFFSET_MS, 28_800_000, '偏移常量仍是 8 小时')
ok('四个原模块都 re-export 同一个实现（没有第二份算术留下）')

/** 自动签到的两个窗口常量从生产侧导出，测试不再手抄 30 * 60_000。 */
assert.equal(autoCheckin.DAY_START_SKEW_MS, 1_800_000, '日界后窗口 30 分钟，形状是生产导出的')
assert.equal(autoCheckin.RETRY_MS, 3_600_000, '窗口外的重试间隔 1 小时')
ok('日界窗口与重试间隔由生产导出，测试不手抄常量')

/** 衍生量：分钟偏移（促销时段）、日首（保留期截止）、日键反解。 */
assert.equal(utc8.utc8MinutesOfDay(DAY_START), 0, '日界那一刻是 00:00')
assert.equal(utc8.utc8MinutesOfDay(DAY_START + 22 * 3_600_000), 1_320, '22:00 是当天第 1320 分钟')
assert.equal(utc8.utc8MinutesOfDay(DAY_START - 60_000), 1_439, '前一天最后一分钟是 23:59')
assert.equal(utc8.utc8MinutesOfDay(DAY_START + 43_200_000), 720, '正午 12:00 是 720')
ok('分钟偏移：日界 / 22:00 / 前一天 23:59 / 正午四种情形')

assert.equal(utc8.utc8DayKeyStartMs('2026-10-28'), DAY_START, '日键反解回 UTC+8 00:00')
assert.equal(utc8.utc8DayKeyStartMs('2026-10-27'), DAY_START - DAY, '前一日的日键反解')
assert.equal(utc8.utc8DayKeyStartMs('not-a-day'), Number.NaN, '非法日键返回 NaN，调用方按无法判定处理')
ok('日键反解：跨日界 / 前一日 / 非法输入')

/** 互逆性：任意时刻的日键再反解，必须落回该日的日首。 */
for (const ts of [DAY_START, DAY_START + 1, DAY_START + 43_200_000, DAY_START + DAY - 1, before]) {
  assert.equal(utc8.utc8DayKeyStartMs(utc8.utc8DayKey(ts)), ts - utc8.utc8MsIntoDay(ts), '日键反解回到该日 00:00：' + ts)
}
ok('日键反解在五个时刻上都回到该日 00:00（含负时间戳）')

/**
 * 分钟偏移必须与「平移到 UTC+8 再取墙钟」恒等 —— 促销时段（qoder-adapter）与
 * 活动刷新时刻（qoder-credits）都改成用它，等价性要逐点钉死。
 */
const wallClockMinutes = (ts) => {
  const shifted = new Date(ts + 8 * 3_600_000)
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
}
for (let offset = 0; offset < DAY; offset += 60 * 60_000) {
  assert.equal(utc8.utc8MinutesOfDay(DAY_START + offset), wallClockMinutes(DAY_START + offset), '每小时整点等价：+' + offset)
}
for (const ts of [DAY_START + 60_049, DAY_START + 59_999, DAY_START + 21 * 3_600_000 + 30 * 60_000, before]) {
  assert.equal(utc8.utc8MinutesOfDay(ts), wallClockMinutes(ts), '非整点等价：' + ts)
}
ok('分钟偏移与「UTC+8 墙钟取时取分」在 24 个整点与 4 个非整点上恒等')

console.log(`utc8: ${checks} 项通过`)
