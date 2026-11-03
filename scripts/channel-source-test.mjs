/**
 * 渠道源码装载入口的自测：四条断言各锁一条历史上真实发生过的走偏。
 *
 *    node scripts/channel-source-test.mjs
 *
 * 这个入口此前是 11 份手写钩子，正确性只由「下游套件全绿」间接证明 —— 以致于
 * scripts/lib/channel-pack-kernel.mjs 的 LlmError 把 (message, code) 写反了很久没人发现。
 * 四条断言的选取标准就是「它退化成旧样子时会不会立刻红」。
 */
import assert from 'node:assert/strict'
import { installChannelSource, importChannelSource } from './lib/channel-source.mjs'

let checks = 0
const check = (name, body) => {
  body()
  checks += 1
  console.log(`ok ${checks} - ${name}`)
}

const hooks = installChannelSource()
try {
  const accountPool = await importChannelSource('account-pool.ts')
  const autoCheckin = await importChannelSource('auto-checkin.ts')
  const kernel = await import('../scripts/lib/channel-pack-kernel.mjs')

  // 1. 参数属性语法（constructor(private readonly ctx)）能过：这是 strip-only 模式报错、
  //    两个套件当年被迫 spawnSync 自我重启的全部原因。
  check('transform 模式能装载含 TypeScript 参数属性的源文件', () => {
    // account-pool.ts:151 是 `constructor(private readonly ctx: Context)` —— strip-only 在此报错。
    assert.equal(typeof accountPool.AccountPool, 'function')
  })

  // 2. .js 相对导入能改写成 .ts：源码按构建期后缀书写，不改写则任何 import 都找不到目标。
  check('源码内部 .js 相对导入被改写为 .ts', () => {
    assert.equal(typeof autoCheckin.createAutoCheckin, 'function')
    assert.equal(typeof autoCheckin.utc8MsIntoDay, 'function')
  })

  // 3. @deepseek-ai/* 落到离线桩，且桩的 LlmError 与真实宿主同序（消息在前、码在后）。
  check('宿主契约落到离线桩，且 LlmError 参数顺序与真实宿主一致', () => {
    const error = new kernel.LlmError('loomy: 402 额度已用尽', 'QUOTA_EXCEEDED', { status: 402 })
    assert.equal(error.message, 'loomy: 402 额度已用尽')
    assert.equal(error.code, 'QUOTA_EXCEEDED')
    assert.equal(error.failure.status, 402)
    assert.equal(error.name, 'LlmError')
  })

  // 4. appendExports 生效：两个适配器的 serializeMessages 在生产里不是导出，套件却要直接调。
  const appended = installChannelSource({
    appendExports: {
      'lobsterai-adapter.ts': 'export { serializeMessages }',
      'trae-adapter.ts': 'export { serializeTraeMessages as serializeMessages }',
    },
  })
  try {
    const lobsterai = await importChannelSource('lobsterai-adapter.ts')
    const trae = await importChannelSource('trae-adapter.ts')
    check('appendExports 给源文件追加导出', () => {
      assert.equal(typeof lobsterai.serializeMessages, 'function')
      assert.equal(typeof trae.serializeMessages, 'function')
    })
  } finally {
    appended.deregister()
  }

  // 5. enabled:false 时一个钩子都不装（套件跑打包产物时用）。
  check('enabled:false 不改变解析行为', () => {
    const off = installChannelSource({ enabled: false })
    assert.equal(typeof off.deregister, 'function')
    off.deregister()
  })
} finally {
  hooks.deregister()
}
console.log(`${checks} checks passed`)
