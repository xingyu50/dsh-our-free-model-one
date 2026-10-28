/**
 * 自动签到在「UTC+8 日界那一刻」跑的那一轮，会把**昨天**的「已领」当成今天的凭证。
 *
 *     node --experimental-transform-types scripts/auto-checkin-boundary-test.mjs
 *
 * 现场取证（本机真实文档 ~/.our-free-model/channel-pack/auto-checkin.json）：
 *   lastDate 2026-10-28、lastAt = 2026-10-28T00:00:00.809+08:00、
 *   channels 全是「今天已领」——而那一刻四个账号的每日额度**都还没发放**。
 * 结果：当天再没有任何自动签到（armNext 已排到下一天日界），用户看到的就是
 * 「开关开着，但没有自动签到」。
 *
 * 本用例把时间轴压成同步代码：让启动轮落在日界，上游在日界后若干分钟才真正
 * 换日，然后走完一整天，断言当天到底有没有真的领到。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

if (!process.execArgv.includes('--experimental-transform-types')) {
  const { spawnSync } = await import('node:child_process')
  const rerun = spawnSync(
    process.execPath,
    ['--experimental-transform-types', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit' },
  )
  process.exit(rerun.status ?? 1)
}

const root = path.join(fileURLToPath(new URL('..', import.meta.url)))
const sourceRoot = pathToFileURL(path.join(root, 'vendor/channel-pack/src/')).href
const kernel = pathToFileURL(path.join(root, 'scripts/lib/channel-pack-kernel.mjs')).href
// `channel-pack-rpc.ts` 会连带引入 `account-pool.ts`，后者要 `Context` 这个具名导出。
// 基础内核只提供运行时契约，这里按 channel-pack-test.mjs 的同款做法补一个。
const cordisKernel = `data:text/javascript,${encodeURIComponent(`
export * from ${JSON.stringify(kernel)}
export { default } from ${JSON.stringify(kernel)}
export class Context { constructor() { this.store = new Map() } provide() {} get() {} }
`)}`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) return { url: cordisKernel, shortCircuit: true }
    if (context.parentURL?.startsWith(sourceRoot) && specifier.endsWith('.js')) {
      const url = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href
      if (fs.existsSync(fileURLToPath(url))) return { url, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

const { createAutoCheckin } = await import(new URL('auto-checkin.ts', sourceRoot).href)
const { computeClaimSummary } = await import(new URL('channel-pack-rpc.ts', sourceRoot).href)

const TODAY = '2026-10-28'

/**
 * 上游替身：**日界后 5 分钟**才真正换日。
 *
 * 依据：真实文档里 00:00:00.809 那一轮，四个账号全部拿到「已领」；而那一天的
 * 额度在同一份上游里是后来才出现 10-28 的 checkin 记录的。即日界那一刻上游
 * 仍然按「昨天」回答。换日时刻取 5 分钟只是保守下界，不影响结论方向。
 */
const ROLLOVER_MS = Date.parse('2026-10-28T00:05:00+08:00')

/** 每个账号当天是否真的被领取过（用 UTC+8 日期记）。 */
const claimedDays = new Map([
  ['buddy#1', '2026-10-27'], ['buddy#2', '2026-10-27'],
  ['trae#1', '2026-10-27'], ['trae#2', '2026-10-27'],
])

let now = Date.parse('2026-10-27T23:59:30+08:00')
const timers = []
let upstreamClaimCalls = 0

/** 上游此刻认为「今天」是哪天（日界后 5 分钟才换）。 */
const upstreamToday = () => (now >= ROLLOVER_MS
  ? TODAY
  : '2026-10-27')

/**
 * 一次 credits.claimAll：与真实实现同构 —— 先查状态，今日已领则
 * already-claimed，否则真去领并返回 claimed。汇总一律走真实的
 * computeClaimSummary，保证 coversToday 口径与生产一致。
 */
async function claimAll(provider) {
  const day = upstreamToday()
  const ids = provider === 'buddy' ? ['buddy#1', 'buddy#2'] : ['trae#1', 'trae#2']
  const outcomes = []
  for (const id of ids) {
    if (claimedDays.get(id) === day) {
      // 上游「今天已签」——但注意：这里的「今天」是**上游的今天**。
      outcomes.push({ kind: 'already-claimed', message: '今天已签到' })
      continue
    }
    upstreamClaimCalls += 1
    claimedDays.set(id, day)
    outcomes.push({ kind: 'claimed', credit: 100 })
  }
  return { ok: true, value: { results: [], summary: computeClaimSummary(outcomes) } }
}

let doc = {
  enabled: true,
  lastDate: '2026-10-27',
  lastResult: '2 个渠道：4 个账号领取成功（+400积分）',
  lastAt: Date.parse('2026-10-27T09:47:09+08:00'),
  channels: [],
  dismissedRunAt: 0,
}
const store = {
  kind: 'memory',
  load: () => ({ ...doc, channels: doc.channels.map(entry => ({ ...entry })) }),
  save: async next => { doc = { ...next } },
}
const warnings = []

const auto = createAutoCheckin({
  store,
  listProviderIds: async () => ['buddy', 'trae'],
  claim: provider => claimAll(provider),
  now: () => now,
  delayMs: 0,
  schedule: (fn, ms) => {
    const timer = { fn, ms, at: now + ms, fired: false, cancelled: false, cancel() { this.cancelled = true } }
    timers.push(timer)
    return timer
  },
  warn: message => warnings.push(message),
})

/** 推进时钟并触发所有**已到期**的轮，直到没有到期的排定。 */
async function drain() {
  for (let guard = 0; guard < 16; guard += 1) {
    const due = timers.filter(timer => !timer.cancelled && !timer.fired && timer.at <= now)
    if (due.length === 0) return
    for (const timer of due) { timer.fired = true; timer.fn() }
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error('自动签到排定链没有收敛')
}

auto.start()
await drain()
assert.equal(doc.lastDate, '2026-10-27', '启动轮不会改写昨天')

// ── 跨过日界：armNext 会正好排在 00:00:00.000 ──
now = Date.parse('2026-10-28T00:00:00.900+08:00')
await drain()

// 此刻引擎做了什么？
const boundaryRound = { lastDate: doc.lastDate, lastResult: doc.lastResult, lastAt: doc.lastAt }

// ── 走完当天剩下的时间（每小时推一次，让重试链有机会跑） ──
for (let hour = 1; hour <= 23; hour += 1) {
  now = Date.parse('2026-10-28T00:00:00.900+08:00') + hour * 3_600_000
  await drain()
}
now = Date.parse('2026-10-28T23:59:00+08:00')
await drain()

const claimedToday = [...claimedDays.entries()].filter(([, day]) => day === TODAY).map(([id]) => id).sort()

console.log('日界那一轮写入：', JSON.stringify(boundaryRound))
console.log('当天真实领取到：', claimedToday.length === 0 ? '（无）' : claimedToday.join(', '))
console.log('上游实际被领取:', upstreamClaimCalls, '次')

// 用户症状：开关开着，当天却一个账号都没被自动签到。
assert.deepEqual(
  claimedToday,
  ['buddy#1', 'buddy#2', 'trae#1', 'trae#2'],
  '日界那一轮把昨天的「已领」当成今天，之后整天不再重试 ⇒ 当天额度全部漏领',
)
assert.equal(doc.lastDate, TODAY, '当天最终必须记入')
assert.ok(!doc.lastResult.includes('已领'), `当天结果不能只是「已领」：${doc.lastResult}`)
console.log('ok  日界那一轮不会把昨天当成今天，当天额度照常自动签到')
