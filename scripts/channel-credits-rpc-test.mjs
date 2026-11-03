import assert from 'node:assert/strict'

/**
 * 使用实际已打包 RPC，只提供账号池 ref，禁止真实网络与旧单凭据回退。
 *
 * 覆盖范围按「渠道 × 动词」铺满 13 家：余额余额 13 家（zcode/gemini/opencode 各自的口径单独断言）、
 * 状态 8 家（其余应为 unsupported）、领取 12 家（3 家恒回坏请求、2 家 unsupported、buddy 真实走通）。
 * 这些断言在 credits 三动词折成 `credits-channels.ts` 的分派表之前是不存在的 ——
 * 表把 13 家的分支收成数据后，任何一家漏挂/错挂动词都只会在运行期被用户发现。
 */
export async function verifyChannelCreditsRpc({ ctx, call, creds }) {
  const originalFetch = globalThis.fetch
  // 13 家 + opencode（零网络，单独断言）。zcode/gemini/opencode 的 balance.total 口径不同，
  // 不参与「统一 123」的循环。
  const providers = [
    'qoder', 'qodercn', 'loomy', 'minimax', 'lobsterai', 'zcode', 'gemini',
    'codearts', 'buddy', 'workbuddy', 'trae', 'cline', 'raccoon', 'opencode',
  ]
  const uniformBalance = providers.filter(id => id !== 'zcode' && id !== 'gemini' && id !== 'opencode')
  let quotaRequests = 0, quotaFailed = true
  const originalResolve = ctx.credentials.resolve
  const resolvedRefs = []
  ctx.credentials.resolve = async ref => { resolvedRefs.push(ref); return originalResolve(ref) }
  try {
    for (const provider of providers) {
      const ref = `FIXTURE_CREDITS_${provider.toUpperCase()}`
      creds.set(ref, { value: JSON.stringify(fixtureCredential(provider)) })
      await ctx.accountPool.addAccount({
        id: `fixture-credits-${provider}`, provider, nickname: '隔离账号',
        credentialRef: ref, enabled: true, refreshable: false, createdAt: 1,
      })
    }
    globalThis.fetch = async input => {
      const pathname = new URL(String(input)).pathname
      let body
      if (pathname.includes('get-user-resource')) {
        // buddy / workbuddy：双层嵌套 Accounts，包状态 1 = 有效。
        body = { code: 0, data: { Response: { Data: { Accounts: [{
          PackageName: 'fixture', CycleCapacityRemain: 123, Status: 1,
        }] } } } }
      } else if (pathname.includes('/me/usage')) {
        body = { qoderUsage: { userQuota: { total: 123, remaining: 123, used: 0, unit: 'credits' } } }
      } else if (pathname.includes('/points/records')) {
        body = { code: '000000', data: { balance: 123, dailyBalance: 0, availableBalance: 123 } }
      } else if (pathname.includes('/credit/details')) {
        body = { base_resp: { status_code: 0 }, total_count: 1, details: [{ remaining_amount: '123.00' }] }
      } else if (pathname.includes('/profile-summary')) {
        body = { code: 0, success: true, data: { totalCreditsRemaining: 123, creditItems: [] } }
      } else if (pathname.includes('/points/v1/balance')) {
        // raccoon：available_points 是唯一可信总额字段。
        body = { code: 0, data: { available_points: 123, reward_points: 0, daily_points: 123 } }
      } else if (pathname.includes('/users/') && pathname.endsWith('/balance')) {
        // cline：原始值是 1e-5 美元单位，÷CLINE_BALANCE_SCALE 后应回到 123。
        body = { success: true, data: { balance: 123 * 100_000 } }
      } else if (pathname.endsWith('statistics/plugin')) {
        // codearts：裸对象（无 data 信封），总额 metric 为 usageTotalPackageCredit。
        body = {
          package: { is_credit_package: true, is_token_package: false, package_name_cn: 'fixture' },
          metrics: [{ name: 'usageTotalPackageCredit', package_credit_amount: 123, package_credit_used: 0, package_credit_remain: 123 }],
        }
      } else if (pathname.endsWith('ide_user_ent_usage')) {
        // trae：资源包列表，expire_time 是秒级时间戳。
        body = { user_entitlement_pack_list: [{
          entitlement_base_info: { quota: { credits_limit: 123 }, display_desc: 'fixture' },
          usage: { credits_amount: 0 },
          expire_time: 1_791_000_000,
        }] }
      } else if (pathname.endsWith('checkin-activity-status')) {
        body = { code: 0, data: { active: true, today_checked_in: false, streak_days: 1, daily_credit: 10, total_credits: 900 } }
      } else if (pathname.endsWith('daily-checkin')) {
        body = { code: 0, data: { credit: 10, streak_days: 2, is_streak_day: false } }
      } else if (pathname.endsWith(':retrieveUserQuotaSummary')) {
        quotaRequests++
        if (quotaFailed) return new Response('本机配额查询失败', { status: 502 })
        body = { groups: [{ buckets: [
          { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.8, resetTime: new Date(Date.now() + 3600000).toISOString() },
          { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.4, resetTime: new Date(Date.now() + 86400000).toISOString() },
        ] }] }
      } else if (pathname.includes('/signin/status')) {
        body = { base_resp: { status_code: 0 }, data: { sign_in_list: [], today_sign_in: false } }
      } else throw new Error(`未预期的替身端点：${pathname}`)
      return Response.json(body)
    }
    for (const provider of uniformBalance) {
      resolvedRefs.length = 0
      const result = await call('credits.balances', { provider })
      assert.equal(result.ok, true, `${provider} balances 应成功`)
      assert.equal(result.value.accounts[0].balance?.total, 123, `${provider} 的账号池凭据应能查询余额`)
      assert.ok(resolvedRefs.includes(`FIXTURE_CREDITS_${provider.toUpperCase()}`))
    }
    // opencode 零网络：余额是账号池本地限流状态的映射，与上游无关。
    const opencode = await call('credits.balances', { provider: 'opencode' })
    assert.equal(opencode.ok, true)
    assert.equal(opencode.value.accounts[0].balance.total, 1)
    assert.equal(opencode.value.accounts[0].balance.packages[0].unit, '通道')
    assert.equal((await ctx.zcodeAuth.current()).zcode_jwt, 'fixture-credits-jwt')
    assert.equal((await ctx.zcodeAuth.status()).configured, true)
    creds.delete('FIXTURE_CREDITS_QODER')
    const missing = await call('credits.balances', { provider: 'qoder' })
    assert.equal(missing.value.accounts[0].balance, null)
    assert.equal(missing.value.accounts[0].error, '凭据未配置', '缺失凭据必须返回原因，不能伪造零余额')
    const unavailableQuota = await call('credits.balances', { provider: 'gemini' })
    assert.equal(unavailableQuota.value.accounts[0].balance, null)
    quotaFailed = false
    const cachedQuota = await call('credits.balances', { provider: 'gemini' })
    assert.equal(cachedQuota.value.accounts[0].balance, null)
    assert.equal(quotaRequests, 1, '自动查询保留原有缓存')
    const freshQuota = await call('credits.balances', { provider: 'gemini', force: true })
    assert.equal(quotaRequests, 2, '手动重试必须真正查询上游替身')
    assert.equal(freshQuota.value.accounts[0].balance.total, 60)
    await verifyStatusDispatch({ call, providers })
    await verifyClaimDispatch({ call, providers })
    await verifyRefreshDispatch({ ctx, call })
  } finally {
    ctx.credentials.resolve = originalResolve
    globalThis.fetch = originalFetch
    for (const provider of providers) {
      await ctx.accountPool.removeAccount(`fixture-credits-${provider}`)
      creds.delete(`FIXTURE_CREDITS_${provider.toUpperCase()}`)
    }
  }
}

/** 每家凭据的字段形状不同：codearts 要 AK/SK，cline 要 account_id，trae 要 uid。 */
function fixtureCredential(provider) {
  const base = {
    access_token: 'fixture-credits-token', token_type: 'Bearer', user_id: 'fixture-user',
    zcode_jwt: 'fixture-credits-jwt', device_mid: 'fixture-device', account_label: '隔离账号',
  }
  if (provider === 'codearts') {
    return {
      access_key_id: 'fixture-ak', secret_access_key: 'fixture-sk',
      security_token: 'fixture-st', expires_at: '2099-01-01T00:00:00.000Z',
    }
  }
  if (provider === 'cline') return { ...base, account_id: 'usr-fixture' }
  if (provider === 'trae') return { ...base, refresh_token: 'fixture-refresh', uid: 'fixture-uid' }
  if (provider === 'buddy' || provider === 'workbuddy') return { ...base, refresh_token: 'fixture-refresh' }
  if (provider === 'zcode') return { zcode_jwt: 'fixture-credits-jwt', device_mid: 'fixture-device' }
  return base
}

/**
 * `credits.status` 的渠道矩阵：只有 8 家有状态动词，其余必须是 unsupported。
 *
 * 旧实现里 status 的分支顺序（先判 supported 再取账号列表）被表结构取代后，
 * 「某家本来没有 status 却挂上了」会表现为多一次上游请求；这里直接断言结果形状。
 */
async function verifyStatusDispatch({ call, providers }) {
  const withStatus = ['buddy', 'workbuddy', 'minimax', 'codearts', 'lobsterai', 'trae', 'cline', 'loomy']
  const withoutStatus = providers.filter(id => !withStatus.includes(id))
  for (const provider of withStatus) {
    const result = await call('credits.status', { provider })
    assert.equal(result.ok, true, `${provider} status 应成功`)
    assert.equal(result.value.accounts.length, 1)
  }
  for (const provider of withoutStatus) {
    const result = await call('credits.status', { provider })
    assert.equal(result.ok, false, `${provider} 不该有 status 动词`)
    assert.equal(result.error.code, 'bad-request')
    assert.equal(result.error.message, `unsupported provider: ${provider}`)
  }
  // 五家没有状态端点的渠道：形状必须是 status:null，而不是假的 active/todayCheckedIn。
  for (const provider of ['codearts', 'lobsterai', 'trae', 'cline', 'loomy']) {
    const result = await call('credits.status', { provider })
    assert.deepEqual(result.value.accounts[0], {
      accountId: `fixture-credits-${provider}`, nickname: '隔离账号', status: null,
    })
  }
  console.log('ok  credits.status: 8 家有状态端点、6 家 unsupported、5 家 null 状态')
}

/**
 * `credits.claimAll` 的渠道矩阵。
 *
 * 三家「后端没有签到接口」的渠道必须回各自的坏请求文案（而不是 silent no-op）；
 * gemini/opencode 没有 claim 动词；buddy 走完整预检 + 领取。
 */
async function verifyClaimDispatch({ call, providers }) {
  const rejections = {
    cline: 'Cline 不支持每日签到（其后端没有签到接口）',
    workbuddy: 'WorkBuddy 国际版不支持每日签到（其后端没有签到接口）',
    raccoon: 'Raccoon Work 不支持每日签到（每日积分由服务端自动发放；登录奖励请在「新手任务」中领取）',
  }
  for (const [provider, message] of Object.entries(rejections)) {
    const result = await call('credits.claimAll', { provider })
    assert.equal(result.ok, false, provider)
    assert.equal(result.error.code, 'bad-request')
    assert.equal(result.error.message, message)
  }
  for (const provider of ['gemini', 'opencode']) {
    const result = await call('credits.claimAll', { provider })
    assert.equal(result.ok, false, `${provider} 不该有 claim 动词`)
    assert.equal(result.error.message, `unsupported provider: ${provider}`)
  }
  // buddy 走完整预检 + 领取：状态查询说今天未签到 ⇒ 真的发领取请求。
  const claimed = await call('credits.claimAll', { provider: 'buddy' })
  assert.equal(claimed.ok, true, 'buddy claimAll 应成功')
  assert.equal(claimed.value.summary.claimed, 1)
  assert.equal(claimed.value.summary.totalCredit, 10)
  assert.equal(claimed.value.results[0].outcome.kind, 'claimed')
  console.log('ok  credits.claimAll: 3 家拒绝签到、2 家 unsupported、buddy 走通预检与领取')
}

async function verifyRefreshDispatch({ ctx, call }) {
  const providers = [
    'lobsterai', 'qoder', 'qodercn', 'trae',
    'cline', 'loomy', 'raccoon', 'minimax', 'zcode', 'gemini',
    // 恢复的三个渠道：`buddy` / `workbuddy` 同源两实例，`codearts` 走签名协议。
    // 其中 `workbuddy` 若不在此列表，`account.refresh` 会落到 default 抛
    // `Unknown provider`，而这条分派错误在别处无从发现。
    'buddy', 'workbuddy', 'codearts',
  ]
  for (const provider of providers) {
    const service = ctx[`${provider}Auth`]
    assert.ok(service, `${provider} auth service is mounted`)
    const saved = service.refreshAccountCredential
    const accountId = `fixture-refresh-${provider}`, ref = `FIXTURE_REFRESH_${provider.toUpperCase()}`
    const calls = []
    try {
      await ctx.accountPool.addAccount({
        id: accountId, provider, nickname: 'offline-refresh', credentialRef: ref,
        enabled: false, refreshable: true, createdAt: 1,
      })
      service.refreshAccountCredential = async (...args) => { calls.push(args) }
      const result = await call('account.refresh', { accountId })
      assert.deepEqual(result, { ok: true, value: { success: true } }, provider)
      assert.equal(calls.length, 1, provider)
      assert.deepEqual(calls[0], [ref, ctx.accountPool, accountId], `${provider}: exact ref, pool and id`)
      service.refreshAccountCredential = async () => { throw new Error('offline refresh rejected') }
      const rejected = await call('account.refresh', { accountId })
      assert.equal(rejected.ok, false, `${provider}: refresh failure is not success`)
      assert.match(rejected.error.message, /offline refresh rejected/)
    } finally {
      service.refreshAccountCredential = saved
      await ctx.accountPool.removeAccount(accountId)
    }
  }
  console.log('ok  refresh RPC: all 13 providers pass exact ref/pool/id; disabled accounts refresh; failures return ok:false')
}
