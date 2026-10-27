/**
 * 自动签到必须**跨天自动重跑**，而不只是「进程启动那一次」。
 *
 *     node --experimental-transform-types scripts/auto-checkin-daily-test.mjs
 *
 * 真实宿主里 dsh 进程会连续存活多天（线上实测 11 天未重启）。若自动签到只在
 * `start()` 那一次排定一轮，第一天之后它就再也不会触发 —— 表现正是「自动签到
 * 根本没自动跑，手动签到正常」。
 *
 * 本测试用注入的 `now()` 与 `schedule()` 把时间轴压成同步代码：先让它跑完
 * 「当天的启动轮」，再把时钟推到第二天，断言实现已经为第二天排定了下一轮。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 源码里有 TypeScript 参数属性（`constructor(private readonly x)`），strip-only 模式
// 解析不了，必须带 `--experimental-transform-types`。`scripts/test-all.mjs` 只会
// `node <script>`，没有传启动参数的通道，故这里自己补一次。
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

// 源码用 `.js` 后缀写相对导入（构建期由 esbuild 解析），这里映射回 `.ts`。
// `@deepseek-ai/*` 由宿提供，用离线桩顶上（与 channel-pack-test.mjs 同款）。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) return { url: kernel, shortCircuit: true }
    if (context.parentURL?.startsWith(sourceRoot) && specifier.endsWith('.js')) {
      const url = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href
      if (fs.existsSync(fileURLToPath(url))) return { url, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

const { createAutoCheckin } = await import(new URL('auto-checkin.ts', sourceRoot).href)

/** 线上那份文档：10/15 09:47 跑过一轮，之后进程一直没重启。 */
let doc = {
  enabled: true,
  lastDate: '2026-10-15',
  lastResult: '3 个渠道：3 个今天已领，2 个渠道不支持签到',
  lastAt: Date.parse('2026-10-15T09:47:09+08:00'),
  channels: [],
  dismissedRunAt: 0,
}
const store = {
  kind: 'memory',
  load: () => ({ ...doc, channels: doc.channels.map(entry => ({ ...entry })) }),
  save: async next => { doc = { ...next } },
}

let now = Date.parse('2026-10-15T11:13:21+08:00')
const timers = []
let claims = 0
const warnings = []

const auto = createAutoCheckin({
  store,
  listProviderIds: async () => ['loomy'],
  claim: async () => {
    claims += 1
    return {
      ok: true,
      value: {
        results: [],
        summary: {
          claimed: 0, totalCredit: 0, alreadyClaimed: 1, inactive: 0, failed: 0,
          coversToday: 1, totalByUnit: { credit: 0, token: 0 },
        },
      },
    }
  },
  now: () => now,
  delayMs: 30_000,
  schedule: (fn, ms) => {
    // 记下「什么时候该响」：判定到期靠它，而不是靠「排过就算到点」——
    // 否则重排链会自我触发，测试变成忙循环。
    const timer = { fn, ms, at: now + ms, fired: false, cancelled: false, cancel() { this.cancelled = true } }
    timers.push(timer)
    return timer
  },
  warn: message => warnings.push(message),
})

/** 推进时钟并触发所有**已到期**的轮，直到没有到期的排定。 */
async function drain() {
  for (let guard = 0; guard < 8; guard += 1) {
    const due = timers.filter(timer => !timer.cancelled && !timer.fired && timer.at <= now)
    if (due.length === 0) return
    for (const timer of due) { timer.fired = true; timer.fn() }
    // 一轮是 async 的（`cycle()` 里 `await runIfDue()` 之后才重排），必须让它跑完。
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error('自动签到排定链没有收敛（疑似重排逻辑会立刻自我触发）')
}

auto.start()
assert.equal(timers.length, 1, '启动时排定一轮')
assert.equal(timers[0].ms, 30_000, '首轮沿用 30 秒延迟')
await drain()
assert.equal(claims, 0, '当天已经跑过（lastDate 就是今天），首轮被第三道闸拦住')
assert.equal(doc.lastDate, '2026-10-15', '被拦住时不写盘')

// 关键一步：进程不重启，只是时间跨到了第二天。
now = Date.parse('2026-10-16T09:00:00+08:00')
assert.ok(
  timers.some(timer => !timer.cancelled && !timer.fired && timer.at <= now),
  '跨天之后必须有一轮已到期（否则进程存活多天时自动签到永远不再触发）',
)
await drain()
assert.equal(claims, 1, '第二天自动签到实际打了上游')
assert.equal(doc.lastDate, '2026-10-16', '第二天结果写入文档')
assert.equal(auto.state().ranToday, true, '状态灯显示今天已跑')
assert.deepEqual(warnings.filter(line => line.includes('未记入今日')), [], '这不该走「未记入今日」分支')

// 跑完之后必须继续排到下一个日界，否则只是「多活一天」而不是「每天都跑」。
assert.ok(
  timers.some(timer => !timer.cancelled && !timer.fired && timer.at > now),
  '第二天跑完后仍要为第三天排定',
)

auto.stop()
assert.ok(
  timers.every(timer => timer.cancelled || timer.fired),
  'stop() 之后不留任何待执行的轮',
)
console.log('ok  自动签到跨天重跑：进程不重启也能在第二天自动触发')
