/**
 * `credits.ts` 的签到 / 余额契约。
 *
 * 锁定三件事：
 *
 * 1. `fetchCreditBalance` 对**两个产品通用** —— 只切 `product.endpoint`，请求头
 *    与响应结构不区分国内版与国际版（2.1.0 实测结论，见 `USER_RESOURCE_PATH`）。
 * 2. `get-user-resource` 的响应是**双层嵌套** `data.Response.Data.Accounts[]`，
 *    与签到端点的单层 `data` 不同，是本接口最容易解析错的地方。
 * 3. 凭据失效时腾讯网关返回 **HTML 错误页**，必须回退成 `null` / 可读原因，
 *    而不是把 `Unexpected token '<'` 抛给用户。
 *
 * 全程用注入的假 fetcher，不触网。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'

const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith('.') && specifier.endsWith('.js')) {
      const target = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (fs.existsSync(target)) return { url: target.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith(sourceRoot) && url.endsWith('.ts')) return {
      format: 'module', shortCircuit: true,
      source: stripTypeScriptTypes(fs.readFileSync(fileURLToPath(url), 'utf8'), { mode: 'transform', sourceUrl: url }),
    }
    return nextLoad(url, context)
  },
})

const credits = await import('../vendor/channel-pack/src/credits.ts')
const { CODEBUDDY, WORKBUDDY } = await import('../vendor/channel-pack/src/product.ts')

let failures = 0
const check = (name, body) => {
  try { body(); console.log(`ok   ${name}`) }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`) }
}
const checkAsync = async (name, body) => {
  try { await body(); console.log(`ok   ${name}`) }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`) }
}

/** 记录一次请求并返回预设响应体的假 fetcher。 */
const fakeFetcher = (status, body) => {
  const calls = []
  const fetcher = async (url, init) => {
    calls.push({ url, init })
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    return { status, ok: status >= 200 && status < 300, text: async () => text }
  }
  return { fetcher, calls }
}

const credential = {
  access_token: 'token-abc',
  refresh_token: 'refresh-abc',
  domain: 'stale.example',
  user_id: 'user-1',
  enterprise_id: 'ent-1',
}

/** `get-user-resource` 的真实响应形状（双层嵌套）。 */
const balanceBody = {
  code: 0,
  data: {
    Response: {
      Data: {
        Accounts: [
          {
            PackageName: 'Bonus Pack',
            CapacityUnit: 'credits',
            CycleCapacityRemain: 55,
            CycleCapacityRemainPrecise: '55.67',
            CycleCapacitySizePrecise: '100',
            CycleCapacityUsedPrecise: '44.33',
            Status: 0,
            DeductionEndTime: 4_000_000_000_000,
            CycleStartTime: '2026-09-01 00:00:00',
            CycleEndTime: '2026-10-01 00:00:00',
            ExpiredTime: '',
          },
          {
            PackageName: 'Free Plan Subscription',
            CapacityUnit: 'credit',
            CycleCapacityRemainPrecise: '100',
            Status: 0,
            DeductionEndTime: 4_000_000_000_000,
          },
          {
            PackageName: 'Expired Pack',
            CapacityUnit: 'credits',
            CycleCapacityRemainPrecise: '500',
            Status: 3,
            ExpiredTime: '2026-06-02 00:00:00',
          },
        ],
      },
    },
  },
}

await checkAsync('fetchCreditBalance 命中 get-user-resource 端点', async () => {
  assert.equal(credits.USER_RESOURCE_PATH, '/v2/billing/meter/get-user-resource')
  const { fetcher, calls } = fakeFetcher(200, balanceBody)
  await credits.fetchCreditBalance(credential, CODEBUDDY, fetcher)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${CODEBUDDY.endpoint}${credits.USER_RESOURCE_PATH}`)
  assert.equal(calls[0].init.method, 'POST')
})

await checkAsync('两个产品只差 baseURL，请求头逐项同构', async () => {
  const seen = []
  for (const product of [CODEBUDDY, WORKBUDDY]) {
    const { fetcher, calls } = fakeFetcher(200, balanceBody)
    const balance = await credits.fetchCreditBalance(credential, product, fetcher)
    assert.notEqual(balance, null, `${product.productCode} 应解析出余额`)
    const headers = calls[0].init.headers
    assert.ok(headers instanceof Headers)
    assert.equal(calls[0].url, `${product.endpoint}/v2/billing/meter/get-user-resource`)
    assert.equal(headers.get('Authorization'), 'Bearer token-abc')
    assert.equal(headers.get('X-Domain'), product.apiDomain)
    assert.equal(headers.get('X-Product'), 'SaaS')
    assert.equal(headers.get('X-Product-Code'), product.productCode)
    assert.equal(headers.get('X-User-Id'), 'user-1')
    assert.equal(headers.get('X-Enterprise-Id'), 'ent-1')
    assert.equal(headers.get('X-Tenant-Id'), 'ent-1')
    seen.push(balance.total)
  }
  // 同一响应体、两个产品 → 同一个读数（解析路径不因产品而异）
  assert.deepEqual(seen, [seen[0], seen[0]])
})

await checkAsync('X-Domain 取产品配置而非凭据里的陈旧 domain', async () => {
  const { fetcher, calls } = fakeFetcher(200, balanceBody)
  await credits.fetchCreditBalance(credential, WORKBUDDY, fetcher)
  assert.equal(calls[0].init.headers.get('X-Domain'), 'www.workbuddy.ai')
  assert.notEqual(calls[0].init.headers.get('X-Domain'), credential.domain)
})

await checkAsync('解析双层嵌套，只把有效包计入 total', async () => {
  const { fetcher } = fakeFetcher(200, balanceBody)
  const balance = await credits.fetchCreditBalance(credential, CODEBUDDY, fetcher)
  assert.equal(balance.packages.length, 3)
  assert.equal(balance.total, 155.67)
  assert.equal(balance.expiredTotal, 500)
  const [bonus] = balance.packages
  assert.equal(bonus.name, 'Bonus Pack')
  assert.equal(bonus.remaining, 55.67)
  assert.equal(bonus.total, 100)
  assert.equal(bonus.active, true)
  assert.equal(bonus.deductionEndTime, 4_000_000_000_000)
  assert.equal(balance.packages[2].active, false)
})

await checkAsync('凭据失效返回 HTML 错误页 → null，不抛错', async () => {
  const { fetcher } = fakeFetcher(401, '<html><head><title>401 Unauthorized</title></head></html>')
  const balance = await credits.fetchCreditBalance(credential, CODEBUDDY, fetcher)
  assert.equal(balance, null)
})

await checkAsync('业务码非 0 → null（区别于"余额为 0"）', async () => {
  const { fetcher } = fakeFetcher(200, { code: 50001, msg: 'internal' })
  assert.equal(await credits.fetchCreditBalance(credential, CODEBUDDY, fetcher), null)
})

await checkAsync('缺少 data.Response.Data.Accounts 任一层 → null', async () => {
  for (const body of [
    { code: 0, data: {} },
    { code: 0, data: { Response: {} } },
    { code: 0, data: { Response: { Data: { Accounts: 'nope' } } } },
  ]) {
    const { fetcher } = fakeFetcher(200, body)
    assert.equal(await credits.fetchCreditBalance(credential, CODEBUDDY, fetcher), null)
  }
})

await checkAsync('fetchCheckinStatus 解析单层 data', async () => {
  const { fetcher, calls } = fakeFetcher(200, {
    code: 0,
    data: {
      active: true,
      today_checked_in: false,
      streak_days: 3,
      daily_credit: 100,
      today_credit: 0,
      is_streak_day: true,
      total_credits: 300,
      checkin_dates: ['2026-09-13', '2026-09-14'],
      activity_name: '开学季',
      theme_name: '秋日',
      end_time: '2026-10-01 00:00:00',
    },
  })
  const status = await credits.fetchCheckinStatus(credential, CODEBUDDY, fetcher)
  assert.equal(calls[0].url, `${CODEBUDDY.endpoint}/v2/billing/meter/checkin-activity-status`)
  assert.equal(status.active, true)
  assert.equal(status.todayCheckedIn, false)
  assert.equal(status.streakDays, 3)
  assert.deepEqual(status.checkinDates, ['2026-09-13', '2026-09-14'])
  assert.equal(status.activityName, '开学季')
})

await checkAsync('claimDailyCheckin：成功 / 重复 / 无资格 / 失败四类', async () => {
  const cases = [
    [{ code: 0, data: { credit: 100, streak_days: 4, is_streak_day: false } }, 'claimed'],
    [{ code: 10001, msg: '今天已签到，请明天再来' }, 'already-claimed'],
    [{ code: 1001 }, 'already-claimed'],
    [{ code: 1002 }, 'inactive'],
    [{ code: 1003 }, 'inactive'],
    [{ code: 12345, msg: '别的原因' }, 'failed'],
  ]
  for (const [body, kind] of cases) {
    const { fetcher, calls } = fakeFetcher(200, body)
    const outcome = await credits.claimDailyCheckin(credential, CODEBUDDY, fetcher)
    assert.equal(outcome.kind, kind, `code ${body.code} 应判为 ${kind}`)
    assert.equal(calls[0].url, `${CODEBUDDY.endpoint}/v2/billing/meter/daily-checkin`)
  }
})

await checkAsync('claimDailyCheckin：网络异常归入 failed 并保留原因', async () => {
  const fetcher = async () => { throw new Error('socket hang up') }
  const outcome = await credits.claimDailyCheckin(credential, CODEBUDDY, fetcher)
  assert.equal(outcome.kind, 'failed')
  assert.match(outcome.message, /socket hang up/)
})

await checkAsync('原有 15 个导出仍全部存在', async () => {
  const expected = [
    'roundCredits', 'normalizeCreditUnit', 'claimUnitOf', 'formatCreditAmount',
    'formatTokenAmount', 'claimUnitLabel', 'formatUnitAmount', 'formatClaimGains',
  ]
  for (const name of expected) assert.equal(typeof credits[name], 'function', name)
  assert.equal(credits.claimUnitLabel('token'), 'Token')
  assert.equal(credits.formatClaimGains({ credit: 100, token: 1e8 }), '+100.00MToken, +100积分')
  assert.equal(credits.normalizeCreditUnit('credits'), 'credit')
})

if (failures === 0) console.log('buddy-credits-test: OK')
else { console.error(`buddy-credits-test: ${failures} failure(s)`); process.exit(1) }
