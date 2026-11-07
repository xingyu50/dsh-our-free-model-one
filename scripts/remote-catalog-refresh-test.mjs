/**
 * 远端模型目录的「手动重拉 / 差异覆盖」契约。
 *
 * 用真源码（scripts/lib/channel-source.mjs）装载，不触网：
 *   1. RemoteCatalogGate —— 目录拉取失败后 30s 冷却（既有行为），
 *      用户显式 force 时绕过冷却。账号选号的累计冷却策略不在这里，
 *      两者是不同领域。
 *   2. remoteCatalogChanged —— 按 id 稳定序列化比对，纯顺序变化不算变化。
 *   3. forceRefreshRemoteCatalog —— 一致不覆盖、不一致才覆盖；
 *      上游空/失败不动缓存；不 fall back 成本地兜底表。
 *
 * 运行：node scripts/remote-catalog-refresh-test.mjs
 */
import assert from 'node:assert/strict'
import { installChannelSource, importChannelSource } from './lib/channel-source.mjs'

installChannelSource()

const { RemoteCatalogGate, REMOTE_CATALOG_COOLDOWN_MS } =
  await importChannelSource('remote-catalog-gate.ts')
const { remoteCatalogChanged, forceRefreshRemoteCatalog } =
  await importChannelSource('remote-catalog-refresh.ts')

let failures = 0
const check = (name, body) => {
  try { body(); console.log(`ok   ${name}`) }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`) }
}
const checkAsync = async (name, body) => {
  try { await body(); console.log(`ok   ${name}`) }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`) }
}

// ── 1. 闸门：目录拉取的既有 30s 冷却 + 手动 force ─────────────────────────
check('目录冷却常量仍是 30s（与账号选号策略无关）', () => {
  assert.equal(REMOTE_CATALOG_COOLDOWN_MS, 30_000)
})

await checkAsync('一次失败即进入 30s 冷却，到点自动解除', async () => {
  let now = 1_700_000_000_000
  const gate = new RemoteCatalogGate({ now: () => now })
  assert.equal(await gate.run(async () => false), false)
  assert.equal(await gate.run(async () => true), false, '普通懒加载被冷却挡住')
  now += 29_999
  assert.equal(await gate.run(async () => true), false, '差 1ms 不解除')
  now += 1
  assert.equal(await gate.run(async () => true), true, '满 30s 解除')
})

await checkAsync('force 绕过冷却（手动刷新永远能问上游）', async () => {
  let now = 1_700_000_000_000
  const gate = new RemoteCatalogGate({ now: () => now })
  await gate.run(async () => false)
  assert.equal(await gate.run(async () => true), false)
  assert.equal(await gate.run(async () => true, true), true, 'force 不受 retryAt 影响')
})

await checkAsync('并发去重：同时来的拉取共享一次请求', async () => {
  let calls = 0
  const gate = new RemoteCatalogGate()
  const [a, b] = await Promise.all([
    gate.run(async () => { calls++; return true }),
    gate.run(async () => { calls++; return true }),
  ])
  assert.equal(calls, 1)
  assert.equal(a, true)
  assert.equal(b, true)
})

// ── 2. 差异判定 ─────────────────────────────────────────────────────────────
check('缓存未建立 + 拿到非空上游 = 有变化', () => {
  assert.equal(remoteCatalogChanged(undefined, [{ id: 'a', name: 'A' }]), true)
})
check('缓存未建立 + 上游也空 = 无变化', () => {
  assert.equal(remoteCatalogChanged(undefined, []), false)
})
check('条数变化 = 有变化', () => {
  assert.equal(remoteCatalogChanged([{ id: 'a' }], [{ id: 'a' }, { id: 'b' }]), true)
})
check('同 id 但字段变化 = 有变化', () => {
  assert.equal(remoteCatalogChanged(
    [{ id: 'hy4free', creditsRate: 'x0.00', discountedCreditsRate: '免费' }],
    [{ id: 'hy4free', creditsRate: 'x0.29', discountedCreditsRate: undefined }]), true)
})
check('字段顺序不同 / 条目顺序不同都不算变化', () => {
  const a = [{ id: 'a', meta: { x: 1, y: 2 } }, { id: 'b', meta: { x: 3, y: 4 } }]
  const b = [{ meta: { y: 4, x: 3 }, id: 'b' }, { meta: { y: 2, x: 1 }, id: 'a' }]
  assert.equal(remoteCatalogChanged(a, b), false)
})
check('undefined 字段与缺字段等价，null 不等价', () => {
  assert.equal(remoteCatalogChanged([{ id: 'a', x: undefined }], [{ id: 'a' }]), false)
  assert.equal(remoteCatalogChanged([{ id: 'a', x: null }], [{ id: 'a' }]), true)
})

// ── 3. 手动重拉：不一致才覆盖 ───────────────────────────────────────────────
const makeAdapter = (gate, fetch, cached, commit, transform) => ({
  gate,
  fetch,
  cached: () => cached.value,
  commit: models => { commit.count++; cached.value = [...models] },
  ...(transform ? { transform } : {}),
})

await checkAsync('手动拉回一致 → 不覆盖（commit 0 次）', async () => {
  const gate = new RemoteCatalogGate()
  const cached = { value: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] }
  const commit = { count: 0 }
  const result = await forceRefreshRemoteCatalog(makeAdapter(
    gate, async () => [{ id: 'b', name: 'B' }, { id: 'a', name: 'A' }], cached, commit))
  assert.deepEqual(result, { changed: false, upstreamOk: true })
  assert.equal(commit.count, 0)
  assert.equal(cached.value[0].id, 'a', '连顺序都保持原样')
})

await checkAsync('手动拉回不一致 → 覆盖（commit 1 次）', async () => {
  const gate = new RemoteCatalogGate()
  const cached = { value: [{ id: 'hy4-preview', name: 'Hy4 preview' }] }
  const commit = { count: 0 }
  const result = await forceRefreshRemoteCatalog(makeAdapter(
    gate, async () => [{ id: 'hy4free', discountedCreditsRate: '免费' }], cached, commit))
  assert.deepEqual(result, { changed: true, upstreamOk: true })
  assert.equal(commit.count, 1)
  assert.deepEqual(cached.value, [{ id: 'hy4free', discountedCreditsRate: '免费' }])
})

await checkAsync('上游返回空 / 抛错 → 不覆盖、不标成功', async () => {
  const gate = new RemoteCatalogGate()
  const cached = { value: [{ id: 'a' }] }
  const commit = { count: 0 }
  const empty = await forceRefreshRemoteCatalog(makeAdapter(gate, async () => [], cached, commit))
  assert.deepEqual(empty, { changed: false, upstreamOk: false })
  const bad = await forceRefreshRemoteCatalog(makeAdapter(gate, async () => { throw new Error('network down') }, cached, commit))
  assert.deepEqual(bad, { changed: false, upstreamOk: false })
  assert.equal(commit.count, 0)
  assert.deepEqual(cached.value, [{ id: 'a' }])
})

await checkAsync('transform 之后才比对（buddy 白名单校正的结果才是缓存）', async () => {
  const gate = new RemoteCatalogGate()
  const cached = { value: [{ id: 'hy4-preview', name: 'Hy4 preview' }, { id: 'hy4free', name: 'Hy4 · x0.00→免费' }] }
  const commit = { count: 0 }
  const transform = models => models.map(m => ({ ...m, name: m.name.toUpperCase() }))
  const same = await forceRefreshRemoteCatalog(makeAdapter(
    gate, async () => [{ id: 'hy4-preview', name: 'Hy4 preview' }, { id: 'hy4free', name: 'Hy4 · x0.00→免费' }],
    cached, commit, transform))
  assert.equal(same.changed, true, 'transform 后的名字不同 → 视为变化')
  assert.equal(commit.count, 1)
})

await checkAsync('上游失败后进入冷却，手动刷新仍绕过冷却', async () => {
  let now = 1_700_000_000_000
  const gate = new RemoteCatalogGate({ now: () => now })
  const cached = { value: [{ id: 'a' }] }
  const commit = { count: 0 }
  let calls = 0
  const fetch = async () => { calls++; throw new Error('offline') }
  const r = await forceRefreshRemoteCatalog(makeAdapter(gate, fetch, cached, commit))
  assert.equal(r.upstreamOk, false)
  assert.equal(calls, 1)
  assert.equal(await gate.run(async () => true), false, '普通懒加载被冷却挡住')
  await forceRefreshRemoteCatalog(makeAdapter(gate, fetch, cached, commit))
  assert.equal(calls, 2, '手动 force 不受冷却影响')
  assert.equal(commit.count, 0)
})

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nremote-catalog-refresh: all checks passed')
