/**
 * `credits-channels.ts` 的分派契约。
 *
 * 从 `channel-pack-rpc.ts` 折出 13 家渠道的 credits 三动词之后，这层没有任何 RPC 胶水，
 * 故可以直接对表断言 —— 不必再起一套宿主替身。锁定四件事：
 *
 * 1. **动词矩阵**与旧 `switch` 逐字一致（哪家支持 status / claim / balances）；
 * 2. **文案契约**逐字保留（三家「不支持签到」、ZCode 两条、每个渠道的失败句）；
 * 3. **不触网**的部分真的不触网（五家 null status、OpenCode 零网络）；
 * 4. **注入点在用**（TRAE 设备代次、LobsterAI 客户端版本、Loomy/Raccoon/ZCode 实例方法）。
 *
 * 全程用伪造 deps + 必要时替换 `globalThis.fetch`，不触网。
 */
import assert from 'node:assert/strict'
import { importChannelSource, installChannelSource } from './lib/channel-source.mjs'

installChannelSource()

const { channelCredits, computeClaimSummary, unsupportedProvider } = await importChannelSource('credits-channels.ts')
const { SUPPORTED_PROVIDERS } = await importChannelSource('channel-pack-store.ts')

let failures = 0
const check = (name, body) => {
  try { body(); console.log(`ok   ${name}`) }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`) }
}
const checkAsync = async (name, body) => {
  try { await body(); console.log(`ok   ${name}`) }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`) }
}

/** 一张账号表（字段与 `ProviderAccountEntry` 对齐，只填被读到的）。 */
const account = (provider, extra = {}) => ({
  id: `fixture-dispatch-${provider}`,
  provider,
  nickname: '分派账户',
  enabled: true,
  credentialRef: `FIXTURE_DISPATCH_${provider.toUpperCase()}`,
  createdAt: 1,
  refreshable: false,
  ...extra,
})

/** 记录调用次数的假注入：任何一次调用都是契约违约，默认抛错。 */
const boom = (label) => () => { throw new Error(`不该调用 ${label}`) }
const makeDeps = (overrides = {}) => ({
  resolve: async (ref) => ({ value: JSON.stringify({ access_token: 'fixture-token', uid: 'fixture-uid', account_id: 'usr-fixture' }) }) ?? ref,
  trae: { generationFor: boom('trae.generationFor'), updateGeneration: boom('trae.updateGeneration') },
  lobsterAiClientVersion: boom('lobsterAiClientVersion'),
  loomy: { claimDailyQuota: boom('loomy.claimDailyQuota'), fetchCreditBalance: boom('loomy.fetchCreditBalance') },
  raccoon: { fetchCreditBalance: boom('raccoon.fetchCreditBalance') },
  zcode: {
    claimDailyFor: boom('zcode.claimDailyFor'),
    mintCaptcha: boom('zcode.mintCaptcha'),
    fetchBalanceFor: boom('zcode.fetchBalanceFor'),
  },
  ...overrides,
})

// ── 1. 表覆盖与动词矩阵 ────────────────────────────────────────────────────

check('表键与 SUPPORTED_PROVIDERS 完全一致（14 家，无多余无缺失）', () => {
  const table = channelCredits(makeDeps())
  assert.deepEqual([...Object.keys(table)].sort(), [...SUPPORTED_PROVIDERS].sort())
})

check('status 动词只挂在旧 switch 有的那 8 家', () => {
  const table = channelCredits(makeDeps())
  const withStatus = Object.entries(table).filter(([, spec]) => spec.status !== undefined).map(([id]) => id).sort()
  // 旧实现：codearts/lobsterai/trae/cline/loomy 显式 null；minimax 走自家端点；
  // 其余落 `productById` 兜底 ⇒ 只有 CodeBuddy 两家有真实状态端点。
  // Qoder 族与 raccoon 在旧实现里既没分支、`productById` 也查不到 ⇒ 一律 unsupported。
  assert.deepEqual(withStatus, [
    'buddy', 'cline', 'codearts', 'lobsterai', 'loomy', 'minimax', 'trae', 'workbuddy',
  ])
})

check('claim 动词覆盖 9 家，另 3 家显式拒绝、2 家缺动词', () => {
  const table = channelCredits(makeDeps())
  const withClaim = Object.entries(table).filter(([, spec]) => spec.claim !== undefined).map(([id]) => id).sort()
  assert.deepEqual(withClaim, [
    'buddy', 'cline', 'codearts', 'lobsterai', 'loomy', 'minimax', 'qoder', 'qodercn', 'raccoon', 'trae', 'workbuddy', 'zcode',
  ])
  // Cline / WorkBuddy / Raccoon 有 claim 但恒回坏请求（各自文案不同）。
  for (const id of ['gemini', 'opencode']) {
    assert.equal(table[id].claim, undefined, `${id} 旧实现落到 unsupported provider，不该有 claim`)
  }
})

check('balances 动词 14 家都有（缺的只有 status/claim）', () => {
  const table = channelCredits(makeDeps())
  const missing = Object.entries(table).filter(([, spec]) => spec.balances === undefined).map(([id]) => id)
  assert.deepEqual(missing, [])
})

check('未知渠道不在表里 —— RPC 层据此回 unsupported provider', async () => {
  const table = channelCredits(makeDeps())
  assert.equal(table['not-a-provider'], undefined)
  assert.deepEqual(unsupportedProvider('not-a-provider'), {
    ok: false,
    error: { code: 'bad-request', message: 'unsupported provider: not-a-provider' },
  })
})

// ── 2. 五家 null status：不触网，形状与旧实现逐字相同 ──────────────────────

await checkAsync('五家「没有状态端点」的渠道回 status:null 且不发请求', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error('不该触网') }
  try {
    const table = channelCredits(makeDeps())
    for (const id of ['codearts', 'lobsterai', 'trae', 'cline', 'loomy']) {
      const result = await table[id].status([account(id)])
      assert.equal(result.ok, true)
      assert.deepEqual(result.value.accounts, [{
        accountId: `fixture-dispatch-${id}`, nickname: '分派账户', status: null,
      }], `${id} 的 null 状态形状`)
    }
    assert.equal(calls, 0, '这五家不该发任何上游请求')
  } finally { globalThis.fetch = originalFetch }
})

// ── 3. 三家「后端没有签到接口」的文案逐字保留 ──────────────────────────────

await checkAsync('Cline / WorkBuddy / Raccoon 的拒绝文案逐字保留', async () => {
  const table = channelCredits(makeDeps())
  const cases = [
    ['cline', 'Cline 不支持每日签到（其后端没有签到接口）'],
    ['workbuddy', 'WorkBuddy 国际版不支持每日签到（其后端没有签到接口）'],
    ['raccoon', 'Raccoon Work 不支持每日签到（每日积分由服务端自动发放；登录奖励请在「新手任务」中领取）'],
  ]
  for (const [id, message] of cases) {
    const result = await table[id].claim([account(id)])
    assert.equal(result.ok, false, `${id} 不该成功`)
    assert.equal(result.error.code, 'bad-request')
    assert.equal(result.error.message, message)
  }
})

// ── 4. 凭据缺失 / 解析失败：六家走骨架的渠道文案一致 ──────────────────────

await checkAsync('凭据缺失时 balances 回「凭据未配置」，且不调用注入的实例方法', async () => {
  let called = 0
  const deps = makeDeps({
    resolve: async () => undefined,
    loomy: { claimDailyQuota: async () => { called++; return { kind: 'failed', code: -1, message: '' } }, fetchCreditBalance: async () => { called++; return null } },
    raccoon: { fetchCreditBalance: async () => { called++; return null } },
    zcode: { claimDailyFor: async () => [], mintCaptcha: async () => '', fetchBalanceFor: async () => { called++; return undefined } },
  })
  const table = channelCredits(deps)
  for (const id of ['loomy', 'raccoon', 'zcode']) {
    const result = await table[id].balances([account(id)], { provider: id })
    assert.equal(result.ok, true)
    assert.equal(result.value.accounts[0].balance, null)
    assert.equal(result.value.accounts[0].error, '凭据未配置')
  }
  assert.equal(called, 0, '凭据都没解析出来，不该调用上游')
})

await checkAsync('凭据 JSON 损坏时 balances 回「凭据解析失败」', async () => {
  const deps = makeDeps({ resolve: async () => ({ value: '{不是 JSON' }) })
  const table = channelCredits(deps)
  const result = await table['loomy'].balances([account('loomy')], { provider: 'loomy' })
  assert.equal(result.ok, true)
  assert.equal(result.value.accounts[0].balance, null)
  assert.equal(result.value.accounts[0].error, '凭据解析失败')
})

// ── 5. ZCode：token 单位、两条错误文案、空桶占位包 ────────────────────────

await checkAsync('ZCode 额度映射：token 单位、企业版与查询失败各自的文案', async () => {
  let call = 0
  const deps = makeDeps({
    zcode: {
      claimDailyFor: boom('zcode.claimDailyFor'),
      mintCaptcha: boom('zcode.mintCaptcha'),
      fetchBalanceFor: async () => {
        call++
        if (call === 1) return undefined
        if (call === 2) return { enterprise: true }
        return { planName: '免费版', remaining: 1e8, buckets: [], expiresAt: 1_791_000_000 }
      },
    },
  })
  const table = channelCredits(deps)
  const first = await table['zcode'].balances([account('zcode')], { provider: 'zcode' })
  assert.equal(first.value.accounts[0].error, '额度查询失败（凭据失效或网络异常）')
  const second = await table['zcode'].balances([account('zcode')], { provider: 'zcode' })
  assert.equal(second.value.accounts[0].error, '企业版账号不下发额度数字，请在 ZCode 内查看')
  const third = await table['zcode'].balances([account('zcode')], { provider: 'zcode' })
  const balance = third.value.accounts[0].balance
  // 空桶时压一个具名占位包，让 UI 显示 0/0 而不是「没有额度」。
  assert.equal(balance.total, 1e8)
  assert.equal(balance.packages.length, 1)
  assert.equal(balance.packages[0].unit, 'token')
  assert.equal(balance.packages[0].name, '免费版')
  assert.equal(balance.packages[0].remaining, 0)
  assert.equal(balance.packages[0].expiredTime, new Date(1_791_000_000 * 1000).toISOString())
})

// ── 6. OpenCode：零网络，两种提示 ──────────────────────────────────────────

await checkAsync('OpenCode 余额是账号池本地状态的映射，不发请求', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('OpenCode 不该触网') }
  try {
    const table = channelCredits(makeDeps())
    const future = Date.now() + 60 * 60_000
    const result = await table['opencode'].balances([
      account('opencode', { enabled: false }),
      account('opencode', { id: 'fixture-dispatch-opencode-limited', modelRateLimits: { 'some-model': future } }),
      account('opencode', { id: 'fixture-dispatch-opencode-ok' }),
    ], { provider: 'opencode' })
    const [disabled, limited, fine] = result.value.accounts
    assert.equal(disabled.error, '已停用')
    assert.equal(disabled.balance.packages[0].unit, '通道')
    assert.ok(limited.error.startsWith('限额中，') && limited.error.endsWith(' 恢复'), limited.error)
    assert.equal(limited.balance.total, 0)
    assert.equal(limited.balance.expiredTotal, 1)
    assert.equal(fine.error, undefined)
    assert.equal(fine.balance.total, 1)
  } finally { globalThis.fetch = originalFetch }
})

// ── 7. 汇总口径：coversToday 与按单位累加 ─────────────────────────────────

check('computeClaimSummary：coversToday 只数「覆盖今天」的结果，单位分开累加', () => {
  const summary = computeClaimSummary([
    { kind: 'claimed', credit: 100, streakDays: 1, isStreakDay: false },
    { kind: 'claimed', credit: 1e8, streakDays: 0, isStreakDay: false, unit: 'token' },
    { kind: 'claimed', credit: 100, streakDays: 0, isStreakDay: false, coversToday: false },
    { kind: 'already-claimed', message: '今天已领' },
    { kind: 'already-claimed', message: '刷新前那一轮', coversToday: false },
    { kind: 'inactive', message: '没活动' },
    { kind: 'failed', code: -1, message: '失败了' },
  ])
  assert.equal(summary.claimed, 3)
  assert.equal(summary.alreadyClaimed, 2)
  assert.equal(summary.inactive, 1)
  assert.equal(summary.failed, 1)
  // 只数 claimed + already-claimed 里 coversToday !== false 的三条
  // （第 3 条 claimed 与第 2 条 already-claimed 显式标了 coversToday:false）
  assert.equal(summary.coversToday, 3)
  // 标量保留原语义（会把不同量纲加在一起）；展示一律用 totalByUnit
  assert.equal(summary.totalCredit, 100 + 1e8 + 100)
  assert.deepEqual(summary.totalByUnit, { credit: 200, token: 1e8 })
})

// ── 8. 注入点真的被用：TRAE 设备代次 / LobsterAI 客户端版本 ───────────────

await checkAsync('TRAE 已签到时预检拦下、不发 claim 请求（claim 对重复领取不幂等）', async () => {
  const originalFetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname
    seen.push(path)
    if (path.endsWith('/checkin_credits/status')) {
      return Response.json({ code: 0, enable: true, checked_in: true, streak_days: 3, credits: 150, total_credits: 900 })
    }
    throw new Error(`不该请求 ${path}`)
  }
  try {
    const table = channelCredits(makeDeps())
    const result = await table['trae'].claim([account('trae')])
    assert.equal(result.ok, true)
    assert.equal(result.value.summary.alreadyClaimed, 1)
    assert.equal(result.value.summary.claimed, 0)
    assert.deepEqual(seen.filter((p) => p.endsWith('/claim')), [])
  } finally { globalThis.fetch = originalFetch }
})

await checkAsync('TRAE 领取时把账号池里的设备代次读出来传给 claim', async () => {
  const originalFetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname
    seen.push(path)
    if (path.endsWith('/checkin_credits/status')) {
      return Response.json({ code: 0, enable: true, checked_in: false, streak_days: 2, credits: 150, total_credits: 900 })
    }
    if (path.endsWith('/checkin_credits/claim')) return Response.json({ code: 0, message: 'success' })
    throw new Error(`不该请求 ${path}`)
  }
  const generations = []
  try {
    const deps = makeDeps({
      trae: {
        generationFor: (accountId) => { generations.push(accountId); return 7 },
        updateGeneration: async () => {},
      },
    })
    const table = channelCredits(deps)
    const result = await table['trae'].claim([account('trae')])
    assert.equal(result.ok, true)
    assert.equal(result.value.summary.claimed, 1)
    // 积分取自领取后补查的 status（claim 响应体不含积分数）
    assert.equal(result.value.summary.totalCredit, 150)
    assert.deepEqual(generations, ['fixture-dispatch-trae'])
  } finally { globalThis.fetch = originalFetch }
})

// ── 9. Qoder 族：只有 claim/balances，无 status ────────────────────────────

check('Qoder 两族共用一张 spec，且都没有 status 动词', () => {
  const table = channelCredits(makeDeps())
  for (const id of ['qoder', 'qodercn']) {
    assert.equal(table[id].status, undefined)
    assert.equal(typeof table[id].claim, 'function')
    assert.equal(typeof table[id].balances, 'function')
  }
})

if (failures === 0) console.log('channel-credits-dispatch-test: OK')
else { console.error(`channel-credits-dispatch-test: ${failures} failure(s)`); process.exit(1) }
