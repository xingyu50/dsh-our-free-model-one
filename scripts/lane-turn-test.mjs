#!/usr/bin/env node
/**
 * `laneTurn` 的接口契约。
 *
 * 这个模块存在的理由：四条车道已经 import 同一组原语（readHead / sniffBody /
 * replayStream，都由 src/http.js 导出），却各自重写一遍约 40 行编排。本测试
 * 断言的是**编排**的正确性 —— 一个 transport，一个 classify，一个 onData。
 *
 * 测试全部穿过 laneTurn 这一个接口：不 import readHead / sniffBody，也不碰
 * 任何一条车道的私有函数。这样四条车道可以独立重构而不动这里。
 *
 * Run: node scripts/lane-turn-test.mjs
 */
import assert from 'node:assert/strict'
import { laneTurn, retryAfterHeaderMs } from '../src/lane-turn.js'
import { isHtmlFrontProxyPage } from '../src/http.js'

let failures = 0
let checks = 0
const check = async (name, run) => {
  checks += 1
  try { await run(); console.log(`ok ${checks} - ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL ${name} — ${error.message}`) }
}

/** A Response-shaped object over one fixed body. */
function responseOf({ status = 200, body = '', headers = {} } = {}) {
  const encoded = new TextEncoder().encode(body)
  let sent = false
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => headers[String(name).toLowerCase()] ?? null },
    body: {
      getReader() {
        return {
          async read() {
            if (sent) return { done: true, value: undefined }
            sent = true
            return { done: false, value: encoded }
          },
          async cancel() {},
          releaseLock() {},
        }
      },
    },
    async text() { return body },
  }
}

const sseBody = 'data: {"a":1}\n\ndata: {"b":2}\n\n'
const classifyNoop = (status, text) => Object.assign(new Error(`refused ${status}: ${text.slice(0, 40)}`), { status })

await check('an SSE answer reaches onData frame by frame', async () => {
  const frames = []
  const result = await laneTurn({
    transport: async () => responseOf({ body: sseBody }),
    url: 'http://lane.test/chat',
    headers: {},
    body: '{}',
    onData: frame => frames.push(frame),
    classify: classifyNoop,
    timeoutMs: 5000,
  })
  assert.equal(result.status, 200)
  assert.deepEqual(frames, ['{"a":1}', '{"b":2}'])
})

await check('a JSON answer is folded and delivered as one frame', async () => {
  const frames = []
  await laneTurn({
    transport: async () => responseOf({ body: '{"answer":"hi"}' }),
    url: 'http://lane.test/chat',
    headers: {},
    body: '{}',
    onData: frame => frames.push(frame),
    classify: classifyNoop,
    timeoutMs: 5000,
  })
  assert.deepEqual(frames.map(f => JSON.parse(f)), [{ answer: 'hi' }])
})

await check('onJson replaces the default frame when a wire synthesises', async () => {
  let seen
  const frames = []
  await laneTurn({
    transport: async () => responseOf({ body: '{"answer":"hi"}' }),
    url: 'http://lane.test/chat',
    headers: {},
    body: '{}',
    onData: frame => frames.push(frame),
    classify: classifyNoop,
    onJson: payload => { seen = payload },
    timeoutMs: 5000,
  })
  assert.deepEqual(seen, { answer: 'hi' }, 'the lane got the parsed document')
  assert.deepEqual(frames, [], 'and no default frame was emitted')
})

await check('a non-2xx answer goes to classify with the raw text', async () => {
  let classified
  await assert.rejects(() => laneTurn({
    transport: async () => responseOf({ status: 429, body: 'slow down', headers: { 'retry-after': '7' } }),
    url: 'http://lane.test/chat',
    headers: {},
    body: '{}',
    onData: () => {},
    classify: (status, text, retryAt) => {
      classified = { status, text, retryAt }
      return Object.assign(new Error('refused'), { status })
    },
    timeoutMs: 5000,
  }), /refused/)
  assert.deepEqual(classified, { status: 429, text: 'slow down', retryAt: 7000 }, 'retry-after is converted to ms')
})

await check('an abort during transport reports ABORTED, not TRANSPORT', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(() => laneTurn({
    transport: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }) },
    url: 'http://lane.test/chat',
    headers: {},
    body: '{}',
    signal: controller.signal,
    onData: () => {},
    classify: classifyNoop,
    timeoutMs: 5000,
  }), error => {
    assert.equal(error.code, 'ABORTED', 'a cancelled turn must not look retryable')
    return true
  })
})

await check('describeTransportFailure lets a lane name itself', async () => {
  await assert.rejects(() => laneTurn({
    transport: async () => { throw new Error('ECONNRESET') },
    url: 'http://lane.test/chat',
    headers: {},
    body: '{}',
    onData: () => {},
    classify: classifyNoop,
    describeTransportFailure: error => Object.assign(new Error(`the aggregate lane could not reach the provider: ${error.message}`), { code: 'TRANSPORT' }),
    timeoutMs: 5000,
  }), /the aggregate lane could not reach the provider: ECONNRESET/)
})

await check('an empty body is refused before any sniffing', async () => {
  await assert.rejects(() => laneTurn({
    transport: async () => responseOf({ body: '' }),
    url: 'http://lane.test/chat',
    headers: {},
    body: '{}',
    onData: () => {},
    classify: classifyNoop,
    timeoutMs: 5000,
  }), error => {
    assert.equal(error.code, 'EMPTY_RESPONSE')
    return true
  })
})

await check('an HTML front-proxy page reaches describeHtmlPage, not the JSON path', async () => {
  await assert.rejects(() => laneTurn({
    transport: async () => responseOf({ body: '<!doctype html><html>WAF</html>' }),
    url: 'http://lane.test/chat',
    headers: {},
    body: '{}',
    onData: () => {},
    classify: classifyNoop,
    describeHtmlPage: text => Object.assign(new Error('the provider front proxy answered with markup'), { code: 'CLIENT_ERROR' }),
    timeoutMs: 5000,
  }), /front proxy answered with markup/)
})

await check('transformText applies before JSON.parse and before classify', async () => {
  let classified
  await assert.rejects(() => laneTurn({
    transport: async () => responseOf({ status: 403, body: 'key=SECRET-123' }),
    url: 'http://lane.test/chat',
    headers: {},
    body: '{}',
    onData: () => {},
    classify: (status, text) => { classified = text; return new Error('refused') },
    transformText: text => text.replaceAll('SECRET-123', '[redacted]'),
    timeoutMs: 5000,
  }), /refused/)
  assert.equal(classified, 'key=[redacted]', 'the classifier never sees the raw credential')
})

await check('a payload carrying an error is classified rather than emitted', async () => {
  let classified
  await assert.rejects(() => laneTurn({
    transport: async () => responseOf({ body: '{"error":{"message":"nope"}}' }),
    url: 'http://lane.test/chat',
    headers: {},
    body: '{}',
    onData: () => {},
    classify: (status, text) => { classified = text; return new Error('refused') },
    timeoutMs: 5000,
  }), /refused/)
  assert.match(classified, /nope/)
})

await check('isHtmlFrontProxyPage recognises markup and nothing else', () => {
  assert.equal(isHtmlFrontProxyPage('<!doctype html><html>'), true)
  assert.equal(isHtmlFrontProxyPage('<HTML><body>'), true)
  assert.equal(isHtmlFrontProxyPage('  <html lang="en">'), true)
  assert.equal(isHtmlFrontProxyPage('{"error":"not html"}'), false)
  assert.equal(isHtmlFrontProxyPage('text with <html> inside'), false)
  assert.equal(isHtmlFrontProxyPage(''), false)
})

await check('retryAfterHeaderMs converts seconds and ignores nonsense', () => {
  assert.equal(retryAfterHeaderMs('7'), 7000)
  assert.equal(retryAfterHeaderMs('0'), undefined)
  assert.equal(retryAfterHeaderMs('-3'), undefined)
  assert.equal(retryAfterHeaderMs('soon'), undefined)
  assert.equal(retryAfterHeaderMs(null), undefined)
})

console.log(failures > 0
  ? `lane-turn-test: ${failures} failure(s)`
  : `lane-turn-test: ${checks} checks passed`)
process.exitCode = failures > 0 ? 1 : 0