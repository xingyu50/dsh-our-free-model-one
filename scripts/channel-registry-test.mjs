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
import { importChannelSource, installChannelSource } from './lib/channel-source.mjs'

const hooks = installChannelSource()

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

const registry = await importChannelSource('channel-registry.ts')

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
const { createRaccoonChannel } = await importChannelSource('channels/raccoon.ts')
const { createCodeArtsChannel } = await importChannelSource('channels/codearts.ts')
const { createBuddyChannel, createWorkBuddyChannel } = await importChannelSource('channels/buddy.ts')
const { createLobsteraiChannel } = await importChannelSource('channels/lobsterai.ts')
const { createQoderChannel, createQoderCnChannel } = await importChannelSource('channels/qoder.ts')
const { createTraeChannel } = await importChannelSource('channels/trae.ts')
const { createClineChannel } = await importChannelSource('channels/cline.ts')
const { createLoomyChannel } = await importChannelSource('channels/loomy.ts')
const { createMinimaxChannel } = await importChannelSource('channels/minimax.ts')
const { createGeminiChannel } = await importChannelSource('channels/gemini.ts')
const { createZcodeChannel } = await importChannelSource('channels/zcode.ts')
const { createOpencodeChannel } = await importChannelSource('channels/opencode.ts')

/** 工厂只读 deps，不碰池；空对象足够造出 spec 形状。 */
const emptyPool = {}
/** 造 spec 时不会被调用，只为满足必填的 fetcher 形参。 */
const noFetch = () => Promise.reject(new Error('channel-registry-test: fetch must not be called'))
check('the migrated channel declares a usable id and namespace', () => {
  const spec = createRaccoonChannel({ pool: {} })
  assert.equal(spec.id, 'raccoon', 'id is the channel id')
  assert.equal(spec.namespace, 'llm-raccoon', 'namespace keeps the llm- prefix')
  assert.equal(typeof spec.createAuth, 'function', 'creates its own auth')
  assert.equal(typeof spec.registerLlm, 'function', 'registers its own adapter')
})


/**
 * 十三家渠道的 spec 全表：id 与 namespace 逐项钉死。
 *
 * 这张表是 index.ts 的装配清单本身 —— 少一家、namespace 拼错，设置页就少
 * 一个渠道且不会有任何运行期报错（只在设置页静默消失）。所以这里按名字
 * 断言，而不是断言「数量是 13」。
 */
const factories = {
  codearts: () => createCodeArtsChannel({ pool: emptyPool }),
  buddy: () => createBuddyChannel({ pool: emptyPool }),
  workbuddy: () => createWorkBuddyChannel({ pool: emptyPool }),
  lobsterai: () => createLobsteraiChannel({ pool: emptyPool }),
  qoder: () => createQoderChannel({ pool: emptyPool }),
  qodercn: () => createQoderCnChannel({ pool: emptyPool }),
  trae: () => createTraeChannel({ pool: emptyPool, fetcher: noFetch }),
  cline: () => createClineChannel({ pool: emptyPool, fetcher: noFetch }),
  loomy: () => createLoomyChannel({ pool: emptyPool }),
  raccoon: () => createRaccoonChannel({ pool: emptyPool }),
  minimax: () => createMinimaxChannel({ pool: emptyPool }),
  gemini: () => createGeminiChannel({ pool: emptyPool, fetcher: noFetch }),
  zcode: () => createZcodeChannel({ pool: emptyPool }),
}
check('the migrated channels all declare an id and a namespace', () => {
  for (const [id, make] of Object.entries(factories)) {
    const spec = make()
    assert.equal(spec.id, id, `${id}: id is the channel id`)
    assert.equal(spec.namespace, `llm-${id}`, `${id}: namespace keeps the llm- prefix`)
  }
})

check('only opencode has no namespace', () => {
  const spec = createOpencodeChannel({ pool: emptyPool })
  assert.equal(spec.id, 'opencode', 'opencode id')
  assert.equal(spec.namespace, undefined, 'opencode never registers a legacy settings namespace')
})

/**
 * RPC 的 auths 键：十三个键里只有 qodercn 与渠道 id 不同名。
 *
 * `ChannelPackAuths` 的形参写的是驼峰 `qoderCn`（历史命名），而渠道 id 是全
 * 小写 `qodercn`。这张表是 `index.ts` 建 auths 对象的唯一依据，写错一个键
 * 就是该渠道 13 个 RPC 方法全部报 unsupported。
 */
check('rpcAuthKey differs from the channel id only for qodercn', () => {
  const keys = Object.entries(factories).map(([id, make]) => [id, make().rpcAuthKey ?? id])
  assert.deepEqual(
    keys, [
      ['codearts', 'codearts'], ['buddy', 'buddy'], ['workbuddy', 'workbuddy'],
      ['lobsterai', 'lobsterai'], ['qoder', 'qoder'], ['qodercn', 'qoderCn'],
      ['trae', 'trae'], ['cline', 'cline'], ['loomy', 'loomy'], ['raccoon', 'raccoon'],
      ['minimax', 'minimax'], ['gemini', 'gemini'], ['zcode', 'zcode'],
    ],
    'qodercn is the only camel-cased rpc key',
  )
})

/**
 * afterMount 抛错必须被吞掉并留日志。
 *
 * 四段昵称修补原本散在 index.ts 末尾的 fire-and-forget 里，其中一个失败时
 * 只会 console 一行；搬进注册表后如果异常冒出来，就会让**后面所有渠道**都
 * 装不上（raccoon/trae 在 gemini 之后）。
 */
check('mountChannels swallows an afterMount failure and warns', () => {
  const warnings = []
  const spec = {
    id: 'boom',
    namespace: 'llm-boom',
    createAuth: () => ({}),
    registerLlm: () => ({ listAllModels: () => [] }),
    afterMount: () => { throw new Error('nickname repair failed') },
  }
  const runtimes = registry.mountChannels({ logger: { warn: m => warnings.push(m) } }, host, [spec])
  assert.equal(runtimes.length, 1, 'the failing channel is still mounted')
  assert.equal(warnings.length, 1, 'exactly one warning')
  assert.match(warnings[0], /boom/, 'the warning names the channel')
  assert.match(warnings[0], /nickname repair failed/, 'the warning carries the reason')
})

/**
 * dispose 与 auth.stop() 一样只跑一次：两个 ctx.effect 都可能执行卸载。
 */
check('dispose runs once even when unmount happens twice', () => {
  let disposed = 0
  const spec = {
    id: 'disposable',
    createAuth: () => ({}),
    registerLlm: () => ({ listAllModels: () => [] }),
    dispose: () => { disposed += 1 },
  }
  const runtimes = registry.mountChannels({}, host, [spec])
  registry.stopChannels(runtimes)
  registry.stopChannels(runtimes)
  assert.equal(disposed, 1, 'dispose is idempotent with auth.stop()')
})

check('a failing dispose does not upset the remaining channels', () => {
  let laterDisposed = 0
  const runtimes = [
    { spec: { id: 'bad', dispose: () => { throw new Error('browser already closed') } }, auth: {}, adapter: { listAllModels: () => [] } },
    { spec: { id: 'good', dispose: () => { laterDisposed += 1 } }, auth: {}, adapter: { listAllModels: () => [] } },
  ]
  assert.doesNotThrow(() => registry.stopChannels(runtimes))
  assert.equal(laterDisposed, 1, 'the next channel still gets cleaned up')
})

console.log(`channel-registry: ${checks} checks passed`)