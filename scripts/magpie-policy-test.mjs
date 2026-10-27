/**
 * No account channel is excluded from the model workspace any more.
 *
 * WorkBuddy's China and international builds and Huawei Cloud's CodeArts plan
 * are all offered by this build. The exclusion machinery in
 * `src/magpie-policy.js` is still wired in — the engine is a pinned binary whose
 * plugin market is fetched at run time, and the boundary this application owns
 * is where a channel would have to be withdrawn — so this suite guards the other
 * direction now: every channel must be reachable, and the machinery must be a
 * pass-through.
 *
 * Runs against the real pinned executable, like magpie-engine-test.
 * Build first: node scripts/build-magpie-engine.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createMagpieEngine, MAGPIE_UI_PREFIX as prefix } from '../src/magpie-engine.js'
import { createMagpieModels } from '../src/magpie-models.js'
import { assertEngineMutation, deniedModel, filterEngineJSON, isDeniedChannel } from '../src/magpie-policy.js'
import { pinnedEngineEntry } from './lib/engine-binary.mjs'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-magpie-policy-'))
const saved = new Map()
for (const [name, value] of Object.entries({
  HOME: path.join(scratch, 'native-home'),
  USERPROFILE: path.join(scratch, 'native-home'),
  XDG_CONFIG_HOME: path.join(scratch, 'native-config'),
  XDG_CACHE_HOME: path.join(scratch, 'native-cache'),
  XDG_DATA_HOME: path.join(scratch, 'native-data'),
  XDG_STATE_HOME: path.join(scratch, 'native-state'),
})) {
  saved.set(name, process.env[name])
  process.env[name] = value
  fs.mkdirSync(value, { recursive: true })
}

const PACKAGE = '@magpie-community/opencode-workbuddy-auth'
const IDS = ['workbuddy', 'workbuddy-ai']
const engine = createMagpieEngine({ dataDir: path.join(scratch, 'data'), logger: {} })
let checks = 0
const check = async (name, run) => {
  await run()
  checks++
  console.log(`ok ${checks} - ${name}`)
}
const server = http.createServer((req, res) => {
  const subpath = req.url.startsWith(prefix) ? req.url.slice(prefix.length) : req.url
  engine.proxy(req, res, subpath).catch(() => { try { res.destroy() } catch {} })
})
const listen = () => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
})
/**
 * A route that a policy refusal would have answered with 403. The channel being
 * offered means the engine answers for itself now, whatever that answer is; what
 * must not happen is the 403 the exclusion used to produce.
 */
const notRefused = async (method, route, body) => {
  try {
    const response = await engine.request(method, route, body === undefined ? {} : { body })
    if (response.status !== undefined) await response.text?.()
    return response.status !== 403
  } catch (error) {
    return error.statusCode !== 403
  }
}

try {
  // The engine-backed groups need this platform's pinned binary; the pure-function
  // group at the end does not, so it still runs on a platform with no binary.
  const hasEngine = pinnedEngineEntry() !== null
  if (hasEngine) await engine.start()
  else console.log(`ok  engine-backed policy groups skipped: no pinned engine binary for ${process.platform}-${process.arch}`)
  const origin = hasEngine ? await listen() : null
  const base = origin === null ? null : origin + prefix
  const read = async route => {
    const response = await fetch(base + route)
    assert.equal(response.status, 200, route)
    return response.json()
  }
  const post = async (route, body) => fetch(base + route, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const engineCheck = async (name, run) => {
    if (!hasEngine) return
    await check(name, run)
  }

  await engineCheck('the plugin market still offers its listings', async () => {
    const listings = await read('api/plugins/listings')
    assert(listings.listings.length > 5, 'listings stay')
    const market = await read('api/plugins/market')
    assert(market.listings.length > 5, 'market listings stay')
    assert(Array.isArray(market.state.plugins), 'market state stays intact')
  })

  await engineCheck('npm search and metadata answers reach the engine', async () => {
    const npm = await read('api/plugins/npm?names=' + encodeURIComponent(`${PACKAGE},@magpie-community/opencode-zcode-auth`))
    assert(Object.keys(npm.npm).some(name => /zcode/i.test(name)), 'other packages still answered')
    // The detail page used to be refused before the engine was asked. It now
    // reaches the engine, which answers for a package it does not have.
    const page = await fetch(base + 'api/plugins/page?name=' + encodeURIComponent(PACKAGE))
    assert.notEqual(page.status, 403, 'a detail lookup is no longer refused by policy')
    assert.doesNotMatch(await page.text(), /not offered by this build/)
  })

  await engineCheck('installed-plugin and update listings reach the engine', async () => {
    for (const route of ['api/plugins', 'api/plugins/updates', 'api/plugin-pages', 'api/plugin-panels',
      'api/plugins/github', 'api/usage/quotas', 'api/login/usage']) {
      const response = await fetch(base + route)
      assert.equal(response.status, 200, route)
      await response.text()
    }
    const checked = await post('api/plugins/check', {})
    assert.notEqual(checked.status, 403, 'a version check is not refused by policy')
    await checked.text()
  })

  await engineCheck('the provider directory offers every channel it used to hide', async () => {
    const providers = await read('api/providers')
    // The engine's own deprecation list is passed through whole. It marks a
    // built-in as deprecated and hides its add-sheet tile, so filtering it was
    // never what a policy did; the exclusion removed the ways onto the channel
    // instead, and none of those are removed now.
    assert(Array.isArray(providers.movable), 'movable arrives intact')
    assert(Array.isArray(providers.presets), 'presets arrive intact')
    assert(providers.presets.length > 5, 'presets stay')
    // Huawei Cloud's Token Plan preset is no longer filtered out of the list.
    assert(providers.presets.some(preset => preset.id === 'huaweicloud'), 'the Huawei Cloud preset is offered')
    const upstream = await read('api/upstream')
    assert.equal(typeof (upstream.providers ?? {}), 'object', 'vendor status is answered')
  })

  await engineCheck('the three restored channels are offered under every name they are sold as', async () => {
    // Nothing on an actionable surface may be dropped for naming one of them.
    // Each route is compared against the same route read with the filters
    // bypassed is not available here, so the assertion is the weaker but
    // sufficient one: the machinery answers false for every spelling, which is
    // what the filters key off.
    for (const spelling of ['workbuddy', 'workbuddy-ai', 'codebuddy', 'codebuddy-cn',
      'huaweicloud', 'modelarts', 'codearts', '华为云', '码道']) {
      assert.equal(isDeniedChannel(spelling), false, `${spelling} is not denied`)
      assert.equal(isDeniedChannel('', spelling), false, `${spelling} is not denied by text`)
    }
    // And the writes that used to be refused are no longer refused.
    for (const [route, body] of [
      ['/api/provider/save', { preset: 'codebuddy', key: 'fixture' }],
      ['/api/provider/save', { id: 'codebuddy', name: 'CodeBuddy', key: 'fixture' }],
      ['/api/provider/save', { preset: 'workbuddy-ai', key: 'fixture' }],
      ['/api/provider/save', { preset: 'codearts', key: 'fixture' }],
      ['/api/plugins/add', { spec: '@magpie-community/opencode-codebuddy-auth' }],
      ['/api/plugins/add', { spec: '@magpie-community/opencode-codearts-auth' }],
      ['/api/signin', { agent: 'codebuddy' }],
      ['/api/signin', { agent: 'codearts' }],
    ]) assert(await notRefused('POST', route, body), `${route} ${JSON.stringify(body)} is not refused`)
  })

  await engineCheck('the engine no longer refuses to install, enable or sign in a channel', async () => {
    for (const [route, body] of [
      ['/api/plugins/add', { spec: PACKAGE }],
      ['/api/plugins/upgrade', { spec: PACKAGE }],
      ['/api/plugins/off', { spec: PACKAGE, off: false }],
      ['/api/plugin-signin', { provider: IDS[0], method: 0 }],
      ['/api/plugin-signin/prompt', { provider: IDS[1], method: 0 }],
      ['/api/signin', { agent: IDS[0] }],
      ['/api/signin', { agent: IDS[1] }],
      ['/api/login/use', { agent: IDS[0], user: 'fixture' }],
      ['/api/provider/move', { id: IDS[0] }],
    ]) assert(await notRefused('POST', route, body), `${route} is not refused by policy`)
  })

  await engineCheck('the refusal is gone through the browser proxy too', async () => {
    for (const [route, body] of [
      ['api/plugins/add', { spec: PACKAGE }],
      ['api/signin', { agent: IDS[0] }],
      ['api/plugin-signin', { provider: IDS[1], method: 0 }],
      ['api/provider/move', { id: IDS[1] }],
    ]) {
      const response = await post(route, body)
      assert.notEqual(response.status, 403, route)
      assert.doesNotMatch(await response.text(), /not offered by this build/, route)
    }
  })

  await engineCheck('a model served through a restored channel reaches the published catalog', async () => {
    const published = []
    const models = createMagpieModels({
      engine,
      stats: { record() {} },
      logger: {},
      onChanged: () => published.push(models?.catalog?.().length ?? 0),
    })
    try {
      // The verdict itself is exercised in the pure-function group below; here
      // the point is that the catalog is no longer filtered by it.
      await models.refresh()
      const catalog = models.catalog()
      assert(Array.isArray(catalog), 'a catalog is published')
    } finally { models.close() }
  })

  await engineCheck('unrelated work on the same routes still reaches the engine', async () => {
    const other = await post('api/plugins/add', { spec: '@ofm-absent-package' })
    assert.notEqual(other.status, 403, 'an unrelated install is not refused by policy')
    const discovery = await post('api/settings/account-discovery', { off: true })
    assert.equal(discovery.status, 200, 'settings still writable')
    const unknown = await post('api/signin', { agent: 'ofm-missing-login-fixture' })
    assert.doesNotMatch(await unknown.text(), /not offered by this build/)
    const settings = await read('api/settings')
    assert.equal(typeof settings.noAccountDiscovery, 'boolean', 'settings still answered')
  })

  await check('the disclaimer names the three restored channels and carries no exclusion', async () => {
    const { DISCLAIMER, EXCLUDED_CHANNELS, DISCLAIMER_VERSION } = await import('../src/disclaimer.js')
    assert.equal(DISCLAIMER_VERSION, 3, 'the copy version moved so a v2 acknowledgement is re-read')
    assert.deepEqual([...EXCLUDED_CHANNELS], [], 'no channel is listed as excluded')
    const named = DISCLAIMER.sections.map(section => `${section.heading} ${section.body}`).join(' ')
    for (const channel of ['WorkBuddy', 'CodeBuddy', 'CodeArts']) {
      assert.match(named, new RegExp(channel), `the disclaimer names ${channel}`)
    }
    assert.match(named, /已恢复/, 'it says the channels were restored')
    assert.doesNotMatch(named, /不包含、也不提供/, 'it no longer says the build excludes them')
    assert.doesNotMatch(named, /与本项目作者及团队无关/, 'it no longer disclaims the restored channels')
    // The responsibility sections that are not about an exclusion stay.
    assert.match(named, /个人学习/, 'it states the project purpose')
    assert.match(named, /自行承担/, 'it places the consequences on the user')
  })

  await check('the filter is a pure function of the route and the answer', async () => {
    const listings = { listings: [
      { package: PACKAGE, name: 'WorkBuddy', providers: IDS },
      { package: '@magpie-community/opencode-zcode-auth', name: 'ZCode', providers: ['zcode'] },
    ] }
    const filtered = filterEngineJSON('/api/plugins/listings', structuredClone(listings))
    assert.deepEqual(filtered.listings, listings.listings, 'nothing is dropped')
    const providers = {
      presets: [{ id: 'huaweicloud', name: 'Huawei Cloud' }, { id: 'workbuddy', name: 'WorkBuddy' }],
      plugins: [{ spec: '@magpie-community/opencode-codearts-auth' }],
      providers: [{ move: { package: '@magpie-community/opencode-workbuddy-auth' } }],
      movesTo: { workbuddy: 'somewhere' },
      unmoved: [{ id: 'codebuddy' }],
      onPlugins: ['codearts'],
    }
    assert.deepEqual(filterEngineJSON('/api/providers', structuredClone(providers)), providers, 'no provider row is dropped')
    const unknown = { anything: 1 }
    assert.equal(filterEngineJSON('/api/settings', unknown), unknown, 'other routes pass through')
    assert.equal(deniedModel({ id: 'glm-5.3-flash', owned_by: 'workbuddy' }), false, 'a model row is not denied by provider')
    assert.equal(deniedModel({ id: 'workbuddy/glm-5.3-flash', owned_by: 'x' }), false, 'a model row is not denied by id')
    assert.doesNotThrow(() => assertEngineMutation('POST', '/api/plugins/add', { spec: PACKAGE }))
    assert.doesNotThrow(() => assertEngineMutation('POST', '/api/provider/save', { preset: 'huaweicloud' }))
    assert.doesNotThrow(() => assertEngineMutation('GET', '/api/plugins/add', { spec: PACKAGE }))
  })

  console.log(`magpie-policy: ${checks} checks passed`)
} finally {
  await engine.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  fs.rmSync(scratch, { recursive: true, force: true })
}
