/**
 * `credentialExpiresAtMs` 的过期时间解析契约。
 *
 * CodeBuddy 的 `/v2/plugin/auth/token` 只下发相对 `expiresIn`，凭据里往往没有
 * `expires_at`；此时必须回退解析 JWT 的 `exp`，否则该凭据排不进续期队列。
 * 这条回退是 2.1.0 独有、2.7.1 的 `credential-expiry.ts` 没有的行为，
 * 故单独锁住。
 */
import assert from 'node:assert/strict'

const { credentialExpiresAtMs } = await import('../vendor/channel-pack/src/buddy.ts')

let failures = 0
const check = (name, body) => {
  try { body(); console.log(`ok   ${name}`) }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`) }
}

const jwt = exp => {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ exp })}.signature`
}

check('expires_at 缺失时回退 JWT exp', () => {
  assert.equal(credentialExpiresAtMs({ access_token: jwt(1_800_000_000) }), 1_800_000_000_000)
})

check('expires_at 为空串时同样回退 JWT exp', () => {
  assert.equal(credentialExpiresAtMs({ access_token: jwt(1_800_000_001), expires_at: '' }), 1_800_000_001_000)
})

check('纯数字且大于 1e12 视为毫秒时间戳', () => {
  assert.equal(credentialExpiresAtMs({ access_token: jwt(1), expires_at: '1800000000123' }), 1_800_000_000_123)
})

check('纯数字且不大于 1e12 视为秒时间戳', () => {
  assert.equal(credentialExpiresAtMs({ access_token: jwt(1), expires_at: '1800000000' }), 1_800_000_000_000)
})

check('ISO 字符串按 Date.parse 解析', () => {
  const iso = '2027-01-15T08:00:00.000Z'
  assert.equal(credentialExpiresAtMs({ access_token: jwt(1), expires_at: iso }), Date.parse(iso))
})

check('expires_at 优先于 JWT exp', () => {
  assert.equal(credentialExpiresAtMs({ access_token: jwt(1_800_000_000), expires_at: '1800000000' }), 1_800_000_000_000)
})

check('两处都取不到时为 undefined', () => {
  assert.equal(credentialExpiresAtMs({ access_token: 'not-a-jwt' }), undefined)
})

check('expires_at 为无法解析的字符串且无 JWT exp 时为 undefined', () => {
  assert.equal(credentialExpiresAtMs({ access_token: 'a.b', expires_at: 'not-a-date' }), undefined)
})

if (failures === 0) console.log('buddy-credential-test: OK')
else { console.error(`buddy-credential-test: ${failures} failure(s)`); process.exit(1) }
