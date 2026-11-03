/**
 * `account-rotation.ts` 的四条不变量：tried 必须传给池、候选要复查、
 * 空 id 不标记、同一账号只标记一次。
 *
 * 用假账号池直接驱动，不构造任何适配器。
 */
import assert from 'node:assert/strict'
import { installChannelSource, importChannelSource } from './lib/channel-source.mjs'

installChannelSource()
const rotation = await importChannelSource('account-rotation.ts')

const failures = []
function check(name, fn) {
  try { fn() } catch (error) { failures.push(name + ': ' + error.message) }
}
async function checkAsync(name, fn) {
  try { await fn() } catch (error) { failures.push(name + ': ' + error.message) }
}

/** 可观察的假池：记录每次 `getAvailableAccount` 的参数与返回值。 */
function fakePool(accounts) {
  const calls = []
  return {
    calls,
    listAccountsByProvider: provider => accounts.filter(row => row.provider === provider),
    getAvailableAccount: async (provider, modelId, tried) => {
      calls.push({ provider, modelId, tried: tried === undefined ? undefined : [...tried] })
      const hit = accounts.find(row => row.provider === provider
        && row.enabled
        && (tried === undefined || !tried.has(row.id)))
      return hit === undefined ? null : { entry: { id: hit.id }, credential: { access_token: hit.id } }
    },
  }
}

check('budget: 无池时只有首个账号', () => {
  assert.equal(rotation.poolRotationBudget(undefined, 'trae'), 1)
})

check('budget: 取池内启用账号数，且不低于下限', () => {
  const pool = fakePool([
    { provider: 'trae', id: 'a', enabled: true },
    { provider: 'trae', id: 'b', enabled: true },
    { provider: 'trae', id: 'c', enabled: false },
  ])
  assert.equal(rotation.poolRotationBudget(pool, 'trae'), 3, '两个启用号也按下限 3')
  const wide = fakePool(Array.from({ length: 6 }, (_, i) => ({ provider: 'trae', id: 'x' + i, enabled: true })))
  assert.equal(rotation.poolRotationBudget(wide, 'trae'), 6, '号多就多试')
})

await checkAsync('pick: 把 tried 传给池，并就地记入返回的账号', async () => {
  const pool = fakePool([
    { provider: 'trae', id: 'a', enabled: true },
    { provider: 'trae', id: 'b', enabled: true },
  ])
  const tried = new Set(['a'])
  const next = await rotation.pickNextAccount({ pool, provider: 'trae', modelId: 'm', tried })
  assert.equal(next.accountId, 'b')
  assert.deepEqual(pool.calls[0].tried, ['a'], 'tried 必须传到池')
  assert.ok(tried.has('b'), '返回的账号要记入 tried，否则下一轮还会拿到它')
})

await checkAsync('pick: 池说没有下一个时返回 undefined', async () => {
  const pool = fakePool([{ provider: 'trae', id: 'a', enabled: true }])
  const next = await rotation.pickNextAccount({ pool, provider: 'trae', modelId: 'm', tried: new Set(['a']) })
  assert.equal(next, undefined)
})

await checkAsync('pick: 池给出已尝试过的候选时返回 undefined，不重复用它', async () => {
  const pool = {
    calls: [],
    getAvailableAccount: async (_provider, _modelId, tried) => {
      pool.calls.push(1)
      return { entry: { id: 'a' }, credential: { access_token: 'a' } }
    },
  }
  const tried = new Set(['a'])
  const next = await rotation.pickNextAccount({ pool, provider: 'trae', modelId: 'm', tried })
  assert.equal(next, undefined, '候选仍在 tried 里就必须放弃，而不是再试一次同一个号')
  assert.equal(tried.size, 1)
})

await checkAsync('pick: 没有账号池时返回 undefined 且不碰池', async () => {
  const next = await rotation.pickNextAccount({ pool: undefined, provider: 'trae', modelId: 'm', tried: new Set() })
  assert.equal(next, undefined)
})

check('mark: 空账号 id 不算标记过', () => {
  const marks = rotation.createMarkRegistry()
  assert.equal(marks.claim(''), false)
  assert.equal(marks.claim('a'), true)
  assert.equal(marks.claim(''), false, '空 id 也不能借机把登记簿改成已标记')
})

check('mark: 同一账号只标记一次', () => {
  const marks = rotation.createMarkRegistry()
  assert.equal(marks.claim('a'), true)
  assert.equal(marks.claim('a'), false)
  assert.equal(marks.claim('b'), true, '换个账号仍然要标')
})

check('mark: 两个登记簿互不影响（每个请求一份）', () => {
  const first = rotation.createMarkRegistry()
  const second = rotation.createMarkRegistry()
  first.claim('a')
  assert.equal(second.claim('a'), true)
})

if (failures.length > 0) {
  for (const row of failures) console.error('FAIL ' + row)
  process.exit(1)
}
console.log('account rotation: 9 checks passed')
