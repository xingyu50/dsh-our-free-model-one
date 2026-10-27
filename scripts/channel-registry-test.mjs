#!/usr/bin/env node
/**
 * 渠道注册表的一致性契约（可独立运行）。
 *
 * 断言的是「登记只有一处」这一形状，不是某个渠道的业务行为 —— 后者由
 * channel-pack-test.mjs 在挂载层面覆盖。三条断言对应三条**已经发生过**的
 * 故障，见 vendor/channel-pack/src/channel-registry.ts 的模块头。
 *
 * Run: node scripts/channel-registry-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href
const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
const ts = (await import('typescript')).default

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) return { url: kernel, shortCircuit: true }
    // 只给渠道包内部做 .js → .ts 解析，与 channel-pack-test.mjs 的 --source 同款。
    if (context.parentURL?.startsWith(sourceRoot) && specifier.endsWith('.js')) {
      const url = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href
      if (fs.existsSync(fileURLToPath(url))) return { url, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith(sourceRoot) && url.endsWith('.ts')) {
      return {
        format: 'module',
        source: ts.transpileModule(fs.readFileSync(fileURLToPath(url), 'utf8'), {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
          fileName: fileURLToPath(url),
        }).outputText,
        shortCircuit: true,
      }
    }
    return nextLoad(url, context)
  },
})

let checks = 0
const check = (name, run) => {
  try {
    run()
    checks += 1
    console.log(`ok ${checks} - ${name}`)
  } catch (error) {
    console.error(`FAIL ${name} — ${error.message}`)
    process.exitCode = 1
  }
}

const registry = await import('../vendor/channel-pack/src/channel-registry.ts')

/**
 * `mountChannels` 与 `stopChannels` 是 index.ts 唯一的装配入口 —— 它们存在，
 * 才说明两份手抄的 stop() 清单可以被替换掉。
 */
check('registry exports the mount and stop entry points', () => {
  assert.equal(typeof registry.mountChannels, 'function', 'mountChannels is exported')
  assert.equal(typeof registry.stopChannels, 'function', 'stopChannels is exported')
})

const host = {
  readImage: async () => undefined,
  readImageRequest: async () => undefined,
  throwIfAllAccountsRateLimited() {},
}

check('mountChannels builds one runtime per spec, in order', () => {
  const created = []
  const make = id => ({
    id,
    namespace: `llm-${id}`,
    createAuth: () => { created.push(id); return { stop() {} } },
    registerLlm: () => ({ listAllModels: () => [] }),
  })
  const runtimes = registry.mountChannels({}, host, [make('alpha'), make('beta')])
  assert.deepEqual(runtimes.map(r => r.spec.id), ['alpha', 'beta'], 'runtimes keep spec order')
  assert.deepEqual(created, ['alpha', 'beta'], 'each auth is created exactly once')
  assert.ok(runtimes.every(r => typeof r.auth.stop === 'function'), 'every runtime exposes stop()')
  assert.ok(runtimes.every(r => typeof r.adapter.listAllModels === 'function'), 'every runtime exposes an adapter')
})

check('stopChannels stops every runtime and nothing else', () => {
  const stopped = []
  const runtimes = ['alpha', 'beta', 'gamma'].map(id => ({
    spec: { id }, auth: { stop: () => stopped.push(id) }, adapter: { listAllModels: () => [] },
  }))
  registry.stopChannels(runtimes)
  assert.deepEqual(stopped, ['alpha', 'beta', 'gamma'], 'each channel is stopped once, in order')
})

check('stopChannels tolerates an empty registry', () => {
  assert.doesNotThrow(() => registry.stopChannels([]))
})

/**
 * 回归防线：13 个 Auth 类里只有 8 个定义了 stop()，gemini / minimax / raccoon /
 * opencode 没有，cordis 的 Service 也不提供。早先版本把 stop 当成必需，一调用
 * 就抛 `TypeError: auth.stop is not a function`（channel-source 套件抓到的真实
 * 回归）。没有清理需求的渠道不该被当成缺陷。
 */
/**
 * 幂等：index.ts 有两个 ctx.effect 都调 stopChannels（一个随续期调度器武装、
 * 一个无条件注册），宿主可能两个都执行。不幂等的 Auth.stop() 会在卸载时抛错，
 * 并打断它后面的清理步骤。
 */
check('stopChannels stops each auth once even when called twice', () => {
  const stopped = []
  const runtimes = [{ spec: { id: 'alpha' }, auth: { stop: () => stopped.push('alpha') }, adapter: { listAllModels: () => [] } }]
  registry.stopChannels(runtimes)
  registry.stopChannels(runtimes)
  assert.deepEqual(stopped, ['alpha'], 'a second unload pass does not stop it again')
})

check('stopChannels skips an auth that has no stop()', () => {
  const stopped = []
  const runtimes = [
    { spec: { id: 'with-stop' }, auth: { stop: () => stopped.push('with-stop') }, adapter: { listAllModels: () => [] } },
    { spec: { id: 'without-stop' }, auth: {}, adapter: { listAllModels: () => [] } },
    { spec: { id: 'also-with-stop' }, auth: { stop: () => stopped.push('also-with-stop') }, adapter: { listAllModels: () => [] } },
  ]
  assert.doesNotThrow(() => registry.stopChannels(runtimes), 'an auth without stop() is not an error')
  assert.deepEqual(stopped, ['with-stop', 'also-with-stop'], 'the ones that can stop, do')
})

/**
 * 已迁入渠道的 spec 形状。
 *
 * `createRaccoonChannel` 需要账号池，所以只验证它产出的 spec 合规 —— 不挂载
 * （挂载需要完整的宿主 ctx，由 channel-pack-test.mjs 覆盖）。
 */
const { createRaccoonChannel } = await import('../vendor/channel-pack/src/channels/raccoon.ts')
check('the migrated channel declares a usable id and namespace', () => {
  const spec = createRaccoonChannel({ pool: {} })
  assert.equal(spec.id, 'raccoon', 'id is the channel id')
  assert.equal(spec.namespace, 'llm-raccoon', 'namespace keeps the llm- prefix')
  assert.equal(typeof spec.createAuth, 'function', 'creates its own auth')
  assert.equal(typeof spec.registerLlm, 'function', 'registers its own adapter')
})

console.log(`channel-registry: ${checks} checks passed`)