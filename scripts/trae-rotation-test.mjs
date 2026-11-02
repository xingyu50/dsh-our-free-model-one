/**
 * TRAE 适配器级的换号行为（真实 TraeAdapter，注入假池与假上游）。
 *
 * 与 scripts/trae-selection-test.mjs 的分工：那里测的是**纯逻辑**
 * （排序、冷却算式、账本），这里测的是**适配器怎么用它们** ——
 * 换号预算是否随池大小自适应、流内哨兵码是否还会漏给上层、
 * 失败到底记在哪一类、什么情况绝不重放。
 *
 * 由 scripts/channel-pack-test.mjs 的 --source 路径调用（复用它的
 * registerHooks 与内核桩）。
 */
import assert from 'node:assert/strict'

const credentialOf = token => ({
  access_token: token,
  refresh_token: `refresh-${token}`,
  uid: token,
  machine_id: '0123456789abcdef0123456789abcdef',
  device_id: '0000000000000000',
})

const sseHeaders = { 'content-type': 'text/event-stream' }
const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`

/** SOLO 流：一条 output + 一条 done。 */
const okStream = (text = 'rotated-ok') => new Response(
  event('output', { response: text }) + event('done', { finish_reason: 'stop' }),
  { headers: sseHeaders },
)

/** 先吐一段正文，再报错。 */
const partialThenError = (code, message) => new Response(
  event('output', { response: 'partial' }) + event('error', { code, message }),
  { headers: sseHeaders },
)

/** 流内业务错误（HTTP 仍是 200 —— 这正是「哨兵码泄漏」的触发条件）。 */
const errorStream = (code, message) => new Response(
  event('error', { code, message }),
  { headers: sseHeaders },
)

/** 空流：HTTP 200 但一个事件都不发（可重试的瞬时故障）。 */
const emptyStream = () => new Response('', { headers: sseHeaders })

const options = {
  model: 'fixture-model',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
}

/**
 * 造一个适配器 + 记录器。
 *
 * @param script 每次 fetch 调用的响应（按顺序消费；用尽后重复最后一项）。
 */
const build = (TraeAdapter, TraeFailureLedger, script, {
  accounts = ['a', 'b', 'c'], current = 'a', withLedger = true, nextAccount,
} = {}) => {
  const sent = []
  const marked = []
  const picked = []
  const pool = {
    listAccountsByProvider: () => accounts.map(id => ({ id, enabled: true })),
    findAccountIdByCredential: async () => current,
    updateModelRateLimit: async (accountId, modelId, resetAtMs) => { marked.push([accountId, modelId, resetAtMs]) },
  }
  const ledger = withLedger
    ? new TraeFailureLedger({
      updateModelRateLimit: async (accountId, modelId, resetAtMs) => { marked.push([accountId, modelId, resetAtMs]) },
    })
    : undefined
  let index = 0
  const adapter = new TraeAdapter({
    credentialRef: 'FIXTURE',
    resolveCredential: async () => credentialOf(current),
    refresh: async () => {},
    accountPool: pool,
    ...withLedger ? { failureLedger: ledger } : {},
    ...nextAccount === undefined ? {} : { nextAccount },
    fetchImpl: async (_url, init) => {
      const token = String(new Headers(init.headers).get('authorization')).slice('Cloud-IDE-JWT '.length)
      sent.push(token)
      const step = script[Math.min(index, script.length - 1)]
      index += 1
      return step(token, sent)
    },
  })
  return { adapter, sent, marked, picked }
}

const consume = async (adapter, signal) => {
  const chunks = []
  let failure
  try { for await (const chunk of adapter.stream({ ...options, ...signal === undefined ? {} : { signal } })) chunks.push(chunk) }
  catch (error) { failure = error }
  return { chunks, failure }
}

export async function verifyTraeRotation({ TraeAdapter, TraeFailureLedger }) {
  /** 按池顺序换号（模拟生产入口注入的选号器）。 */
  const rotateThrough = accounts => async (_model, tried) => {
    const next = accounts.find(id => !tried.has(id))
    return next === undefined ? undefined : { accountId: next, credential: credentialOf(next) }
  }

  // 1. 换号预算 = 池内启用账号数（不再是写死的 3）
  {
    const accounts = ['a', 'b', 'c', 'd', 'e']
    const { adapter, sent } = build(TraeAdapter, TraeFailureLedger,
      [token => token === 'a' ? new Response('quota', { status: 429 }) : okStream()],
      { accounts, nextAccount: rotateThrough(accounts) })
    const { chunks, failure } = await consume(adapter)
    assert.equal(failure, undefined)
    assert.deepEqual(sent, ['a', 'b'], '第一次成功就停，不白烧预算')
    assert.ok(chunks.some(row => row.type === 'text-delta' && row.text === 'rotated-ok'))
  }

  // 2. 全池都限流 → 试满整个池（5 个），再报「所有账号均不可用」
  {
    const accounts = ['a', 'b', 'c', 'd', 'e']
    const { adapter, sent } = build(TraeAdapter, TraeFailureLedger,
      [() => new Response('quota', { status: 429 })],
      { accounts, nextAccount: rotateThrough(accounts) })
    const { failure } = await consume(adapter)
    assert.ok(failure)
    assert.equal(failure.code, 'QUOTA_EXCEEDED')
    assert.deepEqual(sent, accounts, '预算必须等于启用账号数')
  }

  // 3. 【本次修复的核心】流内哨兵码绝不再漏给上层
  {
    const accounts = ['a', 'b', 'c']
    const { adapter, sent } = build(TraeAdapter, TraeFailureLedger,
      [token => token === 'a' ? errorStream(1005, 'plan limit') : okStream()],
      { accounts, nextAccount: rotateThrough(accounts) })
    const { chunks, failure } = await consume(adapter)
    assert.equal(failure, undefined, '流内可换号错误必须被换号吃掉')
    assert.deepEqual(sent, ['a', 'b'])
    assert.ok(chunks.some(row => row.type === 'text-delta' && row.text === 'rotated-ok'))
  }

  // 4. 流内错误 + 池耗尽 → 抛用户能看懂的码，而不是内部哨兵码
  {
    const { adapter } = build(TraeAdapter, TraeFailureLedger,
      [() => errorStream(1005, 'plan limit')], { accounts: ['a'], nextAccount: async () => undefined })
    const { failure } = await consume(adapter)
    assert.ok(failure)
    assert.notEqual(failure.code, 'TRAE_ROTATABLE_STREAM_ERROR', '哨兵码不得逃逸')
    assert.equal(failure.code, 'QUOTA_EXCEEDED')
  }

  // 5. 已经吐出内容后再出错 → 绝不重放（防重复计费/重复执行工具）
  {
    const { adapter, sent } = build(TraeAdapter, TraeFailureLedger,
      [() => partialThenError(4011, 'rate')])
    const { chunks, failure } = await consume(adapter)
    assert.ok(failure, '有输出后的错误必须如实上报')
    assert.equal(sent.length, 1, '有输出后不得重发')
    assert.ok(chunks.some(row => row.type === 'text-delta' && row.text === 'partial'))
  }

  // 6. 401 → 刷新凭据后同账号重发一次（不换号、不计数）
  {
    const { adapter, sent } = build(TraeAdapter, TraeFailureLedger,
      [() => sent.length === 1 ? new Response('unauthorized', { status: 401 }) : okStream()],
      { accounts: ['a', 'b'] })
    const { failure } = await consume(adapter)
    assert.equal(failure, undefined)
    assert.deepEqual(sent, ['a', 'a'], '401 只刷新重试，不换号')
  }

  // 7. 空流 → 同账号再试一次
  {
    const { adapter, sent } = build(TraeAdapter, TraeFailureLedger,
      [() => sent.length === 1 ? emptyStream() : okStream()],
      { accounts: ['a', 'b'] })
    const { failure } = await consume(adapter)
    assert.equal(failure, undefined, '空响应只是一次瞬时故障')
    assert.deepEqual(sent, ['a', 'a'], '空响应在同账号重试，不换号')
  }

  // 8. 用户取消 → 绝不再换号打上游
  {
    const controller = new AbortController()
    const { adapter, sent } = build(TraeAdapter, TraeFailureLedger,
      [() => { controller.abort(); return new Response('quota', { status: 429 }) }])
    const { failure } = await consume(adapter, controller.signal)
    assert.ok(failure)
    assert.equal(sent.length, 1, '取消后不得继续换号')
  }

  // 9. 5xx 仍换号但不写限流标记（上游抽风不该惩罚好号）
  {
    const accounts = ['a', 'b', 'c']
    const { adapter, sent, marked } = build(TraeAdapter, TraeFailureLedger,
      [() => new Response('boom', { status: 503 })],
      { accounts, nextAccount: rotateThrough(accounts) })
    const { failure } = await consume(adapter)
    assert.ok(failure)
    assert.equal(failure.code, 'SERVER')
    assert.equal(sent.length, 3, '5xx 仍可换号（换台机器再试是合理的）')
    assert.deepEqual(marked, [], '5xx 不写限流标记')
  }

  // 10. 会话失效（401）连撞整个池 → 换号看满全池，且该计数
  {
    const accounts = ['a', 'b', 'c']
    const { adapter, sent, marked } = build(TraeAdapter, TraeFailureLedger,
      [() => new Response('token 失效', { status: 401 })],
      { accounts, nextAccount: rotateThrough(accounts) })
    const { failure } = await consume(adapter)
    assert.ok(failure)
    // 刷新重试**整个请求只允许一次**（避免每次 401 都把全池刷两遍）：
    // 'a' 刷新后原地重试仍 401 → 换 b → 换 c → 预算用尽。
    assert.deepEqual(sent, ['a', 'a', 'b', 'c'], '刷新重试只一次，其余走换号')
  }

  console.log('ok  trae rotation: 预算随池、流内错误不再泄漏哨兵码、有输出不重放、401/空流同账号重试、取消即止、5xx 不惩罚账号')
}
