/**
 * TRAE 选号的全部纯逻辑契约。
 *
 * 覆盖四层（每层都可单独失效，故分开测）：
 *
 * 1. `exponentialCooldownMs` —— 指数增长的算式（阈值前 0、阈值起翻倍、封顶）；
 * 2. `earliestDeductionEndMs` / `isUrgentExpiry` / `orderTraeCandidates` ——
 *    「平时等权轮转、只有紧急才插队」的排序规则；
 * 3. `TraeAccountSelector` —— 游标推进、免费模型不查余额、缓存 TTL、坏凭据跳过；
 * 4. `countsAsTraeFailure` / `TraeFailureLedger` —— 「连续 3 次才冷却」。
 *
 * 全程注入假依赖，不触网。
 */
import assert from 'node:assert/strict'
import { importChannelSource, installChannelSource } from './lib/channel-source.mjs'

installChannelSource()

const selection = await importChannelSource('trae-selection.ts')
const { exponentialCooldownMs, DEFAULT_COOLDOWN_POLICY } = await importChannelSource('cooldown-backoff.ts')

const {
  TRAE_URGENT_WINDOW_MS,
  TRAE_BALANCE_CACHE_TTL_MS,
  TRAE_BALANCE_ERROR_CACHE_TTL_MS,
  earliestDeductionEndMs,
  isUrgentExpiry,
  orderTraeCandidates,
  TraeAccountSelector,
  countsAsTraeFailure,
  TraeFailureLedger,
} = selection

let failures = 0
const check = (name, body) => {
  try { body(); console.log(`ok   ${name}`) }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`) }
}
const checkAsync = async (name, body) => {
  try { await body(); console.log(`ok   ${name}`) }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`) }
}

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_700_000_000_000

/** 造一个积分包（只填选号用得到的字段）。 */
const pack = (remaining, deductionEndTime) => ({
  name: 'p', unit: 'credits', remaining, total: remaining, used: 0, active: true,
  cycleStartTime: '', cycleEndTime: '', expiredTime: '',
  ...deductionEndTime === undefined ? {} : { deductionEndTime },
})
const balanceOf = (...packages) => ({ total: 0, packages, expiredTotal: 0 })

// ── 1. 指数冷却 ────────────────────────────────────────────────────────────
check('冷却：阈值前不冷却', () => {
  assert.equal(exponentialCooldownMs(1), 0)
  assert.equal(exponentialCooldownMs(2), 0)
})
check('冷却：阈值起 5 分钟，之后翻倍', () => {
  assert.equal(exponentialCooldownMs(3), 300_000)
  assert.equal(exponentialCooldownMs(4), 600_000)
  assert.equal(exponentialCooldownMs(5), 1_200_000)
})
check('冷却：封顶 30 分钟', () => {
  assert.equal(exponentialCooldownMs(8), 1_800_000)
  assert.equal(exponentialCooldownMs(100), 1_800_000)
})
check('冷却：非法输入当未冷却', () => {
  assert.equal(exponentialCooldownMs(Number.NaN), 0)
  assert.equal(exponentialCooldownMs(Number.POSITIVE_INFINITY), 0)
})
check('冷却：默认策略与 captcha 的起步不同（3 次 / 5 分钟 / 30 分钟）', () => {
  assert.equal(DEFAULT_COOLDOWN_POLICY.threshold, 3)
  assert.equal(DEFAULT_COOLDOWN_POLICY.baseMs, 300_000)
  assert.equal(DEFAULT_COOLDOWN_POLICY.maxMs, 1_800_000)
})

// ── 2. 最早作废时刻 ─────────────────────────────────────────────────────────
check('作废时刻：取所有有效包里最早的', () => {
  assert.equal(earliestDeductionEndMs(balanceOf(pack(10, NOW + 9 * DAY), pack(20, NOW + 2 * DAY))), NOW + 2 * DAY)
})
check('作废时刻：忽略已失效 / 已耗尽 / 无到期时间的包', () => {
  const balance = balanceOf(
    { ...pack(10, NOW + 1 * DAY), active: false },
    pack(0, NOW + 2 * DAY),
    pack(10, undefined),
    pack(30, NOW + 5 * DAY),
  )
  assert.equal(earliestDeductionEndMs(balance), NOW + 5 * DAY)
})
check('作废时刻：没有可用包 → undefined（= 不会作废）', () => {
  assert.equal(earliestDeductionEndMs(balanceOf()), undefined)
  assert.equal(earliestDeductionEndMs(null), undefined)
  assert.equal(earliestDeductionEndMs(undefined), undefined)
})
check('作废时刻：不看 expiredTime（有效包那里一律是空串）', () => {
  const stale = { ...pack(10, NOW + 7 * DAY), expiredTime: Math.floor(NOW / 1000) }
  assert.equal(earliestDeductionEndMs(balanceOf(stale)), NOW + 7 * DAY)
})

// ── 3. 紧急判定 ─────────────────────────────────────────────────────────────
check('紧急：没有到期时间 → 永不紧急', () => {
  assert.equal(isUrgentExpiry(undefined, [NOW + 1 * DAY], NOW), false)
})
check('紧急：三天内作废 → 紧急', () => {
  assert.equal(isUrgentExpiry(NOW + 2 * DAY, [], NOW), true)
  assert.equal(isUrgentExpiry(NOW + 2 * DAY, [NOW + 300 * DAY], NOW), true)
})
check('紧急：不在窗口内但与主流差一倍以上 → 紧急（存在量词）', () => {
  // 自己还剩 10 天，另一个还剩 21 天（> 2 × 10）→ 紧急。
  assert.equal(isUrgentExpiry(NOW + 10 * DAY, [NOW + 21 * DAY], NOW), true)
})
check('紧急：差不到一倍 → 不紧急', () => {
  assert.equal(isUrgentExpiry(NOW + 10 * DAY, [NOW + 19 * DAY], NOW), false)
})
check('紧急：窗口边界（恰好 3 天算紧急）', () => {
  assert.equal(isUrgentExpiry(NOW + TRAE_URGENT_WINDOW_MS - 1, [], NOW), true)
  assert.equal(isUrgentExpiry(NOW + TRAE_URGENT_WINDOW_MS + 1, [], NOW), false)
})
check('紧急：其他账号没有到期时间时不参与「差一倍」比较', () => {
  assert.equal(isUrgentExpiry(NOW + 10 * DAY, [undefined, undefined], NOW), false)
})

// ── 4. 排序（轮转 + 插队）─────────────────────────────────────────────────
const A = { id: 'a', credentialRef: 'ref-a' }
const B = { id: 'b', credentialRef: 'ref-b' }
const C = { id: 'c', credentialRef: 'ref-c' }
const ids = list => list.map(entry => entry.id)

check('排序：无游标 → 手动顺序', () => {
  assert.deepEqual(ids(orderTraeCandidates([A, B, C], '', new Map(), NOW)), ['a', 'b', 'c'])
})
check('排序：游标在 b → 从 c 开始环绕', () => {
  assert.deepEqual(ids(orderTraeCandidates([A, B, C], 'b', new Map(), NOW)), ['c', 'a', 'b'])
})
check('排序：游标在最后一个 → 回到第一个', () => {
  assert.deepEqual(ids(orderTraeCandidates([A, B, C], 'c', new Map(), NOW)), ['a', 'b', 'c'])
})
check('排序：游标指向已删除的账号 → 从头开始（不跳一圈）', () => {
  assert.deepEqual(ids(orderTraeCandidates([A, B, C], 'gone', new Map(), NOW)), ['a', 'b', 'c'])
})
check('排序：只有一个候选就原样返回', () => {
  assert.deepEqual(ids(orderTraeCandidates([A], 'a', new Map(), NOW)), ['a'])
})
check('排序：紧急号插到队头，其余保持轮转后的相对顺序', () => {
  const ends = new Map([['b', NOW + 1 * DAY]])
  // 游标在 a → 轮转后 [b, c, a]；b 紧急 → [b, c, a]（本来就在头）
  assert.deepEqual(ids(orderTraeCandidates([A, B, C], 'a', ends, NOW)), ['b', 'c', 'a'])
  // 游标在 c → 轮转后 [a, b, c]；b 紧急 → [b, a, c]
  assert.deepEqual(ids(orderTraeCandidates([A, B, C], 'c', ends, NOW)), ['b', 'a', 'c'])
})
check('排序：多个号都紧急时只插最急的那一个', () => {
  const ends = new Map([['a', NOW + 2 * DAY], ['c', NOW + 1 * DAY]])
  assert.deepEqual(ids(orderTraeCandidates([A, B, C], '', ends, NOW)), ['c', 'a', 'b'])
})
check('排序：没有紧急号时纯轮转（不按到期时间排）', () => {
  const ends = new Map([['a', NOW + 300 * DAY], ['b', NOW + 310 * DAY], ['c', NOW + 320 * DAY]])
  // 若按到期排序会是 [a, b, c]；但游标在 b 时必须从 c 开始 —— 轮转优先。
  assert.deepEqual(ids(orderTraeCandidates([A, B, C], 'b', ends, NOW)), ['c', 'a', 'b'])
})

console.log(`-- 选号器（${TRAE_BALANCE_CACHE_TTL_MS}ms / 失败 ${TRAE_BALANCE_ERROR_CACHE_TTL_MS}ms）`)

/** 造一个选号器：`balances` 是 账号 ref → 余额（缺失则查询失败）。 */
const makeSelector = (options = {}) => {
  const calls = { balance: [], credential: [] }
  const selector = new TraeAccountSelector({
    resolveCredential: async (ref) => {
      calls.credential.push(ref)
      if (options.brokenRefs?.has(ref)) return undefined
      return { access_token: `token-${ref}`, refresh_token: 'r', uid: ref }
    },
    fetchBalance: async (credential) => {
      calls.balance.push(credential.uid)
      if (options.failingUids?.has(credential.uid)) throw new Error('boom')
      return options.balances?.get(credential.uid) ?? null
    },
    now: options.now,
    ...options.deps,
  })
  return { selector, calls }
}

await checkAsync('选号：免费模型完全不查余额（零 HTTP）', async () => {
  const { selector, calls } = makeSelector({ now: () => NOW })
  const picked = await selector.select('m', [A, B, C], true)
  assert.equal(picked.accountId, 'a')
  assert.deepEqual(calls.balance, [])
})
await checkAsync('选号：付费模型串行查余额（每个候选一次）', async () => {
  const { selector, calls } = makeSelector({ now: () => NOW, balances: new Map() })
  await selector.select('m', [A, B, C], false)
  assert.deepEqual(calls.balance, ['ref-a', 'ref-b', 'ref-c'])
})
await checkAsync('选号：连续两次请求轮转到下一个号', async () => {
  const { selector } = makeSelector({ now: () => NOW, deps: { ttlMs: TRAE_BALANCE_CACHE_TTL_MS } })
  assert.equal((await selector.select('m', [A, B, C], true)).accountId, 'a')
  assert.equal((await selector.select('m', [A, B, C], true)).accountId, 'b')
  assert.equal((await selector.select('m', [A, B, C], true)).accountId, 'c')
  assert.equal((await selector.select('m', [A, B, C], true)).accountId, 'a')
})
await checkAsync('选号：游标按模型分账（换模型不影响本模型进度）', async () => {
  const { selector } = makeSelector({ now: () => NOW })
  await selector.select('m1', [A, B], true)
  assert.equal(selector.cursorOf('m1'), 'a')
  assert.equal(selector.cursorOf('m2'), '')
  assert.equal((await selector.select('m2', [A, B], true)).accountId, 'a')
  assert.equal((await selector.select('m1', [A, B], true)).accountId, 'b')
})
await checkAsync('选号：快作废的号插队（其余号仍轮转）', async () => {
  const balances = new Map([
    ['ref-a', balanceOf(pack(100, NOW + 200 * DAY))],
    ['ref-b', balanceOf(pack(100, NOW + 200 * DAY))],
    ['ref-c', balanceOf(pack(5, NOW + 1 * DAY))],
  ])
  const { selector } = makeSelector({ now: () => NOW, balances })
  // c 紧急 → 第一次就选中 c，游标指向 c。
  assert.equal((await selector.select('m', [A, B, C], false)).accountId, 'c')
  // 但 c 仍然紧急 → 下一次还是 c（插队不是「用一次就不再紧急」）。
  assert.equal((await selector.select('m', [A, B, C], false)).accountId, 'c')
})
await checkAsync('选号：余额缓存命中后不再发请求（成功缓存 60 秒）', async () => {
  let clock = NOW
  const balances = new Map([['ref-a', balanceOf(pack(10, NOW + 100 * DAY))]])
  const { selector, calls } = makeSelector({ now: () => clock, balances })
  await selector.select('m', [A], false)
  assert.equal(calls.balance.length, 1)
  clock += TRAE_BALANCE_CACHE_TTL_MS - 1
  await selector.select('m', [A], false)
  assert.equal(calls.balance.length, 1, 'TTL 内应命中缓存')
  clock += 10
  await selector.select('m', [A], false)
  assert.equal(calls.balance.length, 2, 'TTL 过后应重新查询')
})
await checkAsync('选号：失败结果用更短的 TTL（不把抖动缓存成一分钟）', async () => {
  let clock = NOW
  const { selector, calls } = makeSelector({ now: () => clock, failingUids: new Set(['ref-a']) })
  await selector.select('m', [A], false)
  assert.equal(calls.balance.length, 1)
  clock += TRAE_BALANCE_ERROR_CACHE_TTL_MS + 10
  await selector.select('m', [A], false)
  assert.equal(calls.balance.length, 2, '失败缓存应在 5 秒后就过期')
})
await checkAsync('选号：查不到余额也照样能用（退回纯轮转）', async () => {
  const { selector } = makeSelector({ now: () => NOW, failingUids: new Set(['ref-a', 'ref-b', 'ref-c']) })
  // 全查不到 → ends 为空 → 纯轮转。
  assert.equal((await selector.select('m', [A, B, C], false)).accountId, 'a')
  assert.equal((await selector.select('m', [A, B, C], false)).accountId, 'b')
})
await checkAsync('选号：凭据解析不出的号被跳过，且游标落在真正用上的那个', async () => {
  const { selector } = makeSelector({ now: () => NOW, brokenRefs: new Set(['ref-a']) })
  const picked = await selector.select('m', [A, B, C], true)
  assert.equal(picked.accountId, 'b')
  assert.equal(selector.cursorOf('m'), 'b')
})
await checkAsync('选号：空候选 → undefined（不抛）', async () => {
  const { selector } = makeSelector({ now: () => NOW })
  assert.equal(await selector.select('m', [], false), undefined)
})
await checkAsync('选号：invalidate / resetCursor', async () => {
  let clock = NOW
  const { selector, calls } = makeSelector({ now: () => clock, balances: new Map() })
  await selector.select('m', [A], false)
  assert.equal(calls.balance.length, 1)
  selector.invalidate('a')
  await selector.select('m', [A], false)
  assert.equal(calls.balance.length, 2, 'invalidate(accountId) 应清掉该账号的缓存')
  selector.resetCursor()
  assert.equal(selector.cursorOf('m'), '')
})

// ── 5. 该不该计数 ───────────────────────────────────────────────────────────
const outcome = (kind, status = 0, body = '') => ({ kind, status, body })

check('计数：账号级问题都计数', () => {
  for (const kind of ['session-dead', 'soft-rate', 'hard-plan', 'quota-exceeded', 'not-found']) {
    assert.equal(countsAsTraeFailure(outcome(kind, 500, 'x')), true, kind)
  }
})
check('计数：5xx / 4xx / 无错都不计数（上游抽风不该惩罚好号）', () => {
  assert.equal(countsAsTraeFailure(outcome('server', 503)), false)
  assert.equal(countsAsTraeFailure(outcome('client', 400)), false)
  assert.equal(countsAsTraeFailure(outcome('none', 0)), false)
})
check('计数：模型繁忙优先判掉（即使分类成 soft-rate）', () => {
  assert.equal(countsAsTraeFailure(outcome('soft-rate', 429, '{"code":14003}')), false)
  assert.equal(countsAsTraeFailure(outcome('soft-rate', 429, '模型繁忙，请稍后重试')), false)
  assert.equal(countsAsTraeFailure(outcome('server', 500, 'currently saturated')), false)
})
check('计数：正常响应体里的「模型繁忙」不算（状态码 < 400）', () => {
  assert.equal(countsAsTraeFailure(outcome('none', 0, '模型繁忙')), false)
})

// ── 6. 连续失败账本 ─────────────────────────────────────────────────────────
check('账本：前两次失败不写任何标记', async () => {
  // 同步断言内做不了 await，故这里用「立即返回 Promise」的桩：算法本身同步推进 streak。
  const writes = []
  const ledger = new TraeFailureLedger({
    updateModelRateLimit: async (accountId, modelId, untilMs) => { writes.push([accountId, modelId, untilMs]) },
    now: () => NOW,
  })
  void ledger.noteFailure('a', 'm', outcome('soft-rate', 429))
  void ledger.noteFailure('a', 'm', outcome('soft-rate', 429))
  assert.deepEqual(writes, [])
})
await checkAsync('账本：第三次才写 5 分钟冷却', async () => {
  const writes = []
  const ledger = new TraeFailureLedger({
    updateModelRateLimit: async (accountId, modelId, untilMs) => { writes.push([accountId, modelId, untilMs]) },
    now: () => NOW,
  })
  assert.equal(await ledger.noteFailure('a', 'm', outcome('soft-rate', 429)), 0)
  assert.equal(await ledger.noteFailure('a', 'm', outcome('soft-rate', 429)), 0)
  assert.equal(await ledger.noteFailure('a', 'm', outcome('soft-rate', 429)), NOW + 300_000)
  assert.deepEqual(writes, [['a', 'm', NOW + 300_000]])
  assert.equal(ledger.streakOf('a', 'm'), 3)
})
await checkAsync('账本：第 4/5/6 次翻倍，封顶 30 分钟', async () => {
  const writes = []
  const ledger = new TraeFailureLedger({
    updateModelRateLimit: async (_a, _m, untilMs) => { writes.push(untilMs - NOW) },
    now: () => NOW,
  })
  for (let i = 0; i < 8; i++) await ledger.noteFailure('a', 'm', outcome('hard-plan', 429))
  assert.deepEqual(writes, [300_000, 600_000, 1_200_000, 1_800_000, 1_800_000, 1_800_000])
})
await checkAsync('账本：成功清零', async () => {
  const ledger = new TraeFailureLedger({ updateModelRateLimit: async () => {}, now: () => NOW })
  await ledger.noteFailure('a', 'm', outcome('soft-rate', 429))
  await ledger.noteFailure('a', 'm', outcome('soft-rate', 429))
  assert.equal(ledger.streakOf('a', 'm'), 2)
  ledger.noteSuccess('a', 'm')
  assert.equal(ledger.streakOf('a', 'm'), 0)
  // 重新从 1 数起：又两次仍不冷却。
  assert.equal(await ledger.noteFailure('a', 'm', outcome('soft-rate', 429)), 0)
  assert.equal(await ledger.noteFailure('a', 'm', outcome('soft-rate', 429)), 0)
})
await checkAsync('账本：不计数的那几类既不 +1 也不清零', async () => {
  const ledger = new TraeFailureLedger({ updateModelRateLimit: async () => {}, now: () => NOW })
  await ledger.noteFailure('a', 'm', outcome('soft-rate', 429))
  await ledger.noteFailure('a', 'm', outcome('soft-rate', 429))
  await ledger.noteFailure('a', 'm', outcome('server', 503))
  assert.equal(ledger.streakOf('a', 'm'), 2, '5xx 不该把「差一次到阈值」清零')
  await ledger.noteFailure('a', 'm', outcome('server', 502))
  // 再失败一次就应达到阈值 3。
  assert.equal(await ledger.noteFailure('a', 'm', outcome('soft-rate', 429)), NOW + 300_000)
})
await checkAsync('账本：按 (账号, 模型) 分账', async () => {
  const writes = []
  const ledger = new TraeFailureLedger({
    updateModelRateLimit: async (accountId, modelId) => { writes.push(`${accountId}/${modelId}`) },
    now: () => NOW,
  })
  for (let i = 0; i < 3; i++) await ledger.noteFailure('a', 'm1', outcome('soft-rate', 429))
  for (let i = 0; i < 2; i++) await ledger.noteFailure('a', 'm2', outcome('soft-rate', 429))
  for (let i = 0; i < 3; i++) await ledger.noteFailure('b', 'm1', outcome('soft-rate', 429))
  assert.deepEqual(writes, ['a/m1', 'b/m1'])
})
await checkAsync('账本：写标记失败不上抛', async () => {
  const ledger = new TraeFailureLedger({
    updateModelRateLimit: async () => { throw new Error('state.json 只读') },
    now: () => NOW,
  })
  for (let i = 0; i < 3; i++) {
    assert.equal(await ledger.noteFailure('a', 'm', outcome('soft-rate', 429)), 0)
  }
  // 计数仍然推进（下次仍会尝试写入）。
  assert.equal(ledger.streakOf('a', 'm'), 3)
})
await checkAsync('账本：空账号 id 直接忽略', async () => {
  const ledger = new TraeFailureLedger({ updateModelRateLimit: async () => {}, now: () => NOW })
  assert.equal(await ledger.noteFailure('', 'm', outcome('soft-rate', 429)), 0)
  assert.equal(ledger.streakOf('', 'm'), 0)
})

if (failures > 0) {
  console.error(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\ntrae 选号契约全部通过')
