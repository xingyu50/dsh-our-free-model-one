#!/usr/bin/env node
/**
 * provider 表的护栏：新增 provider 时漏登记，会让该 provider 的账号在
 * state.json 缺失时**静默消失**（凭据还在 .credentials.yaml 里，只是索引建不出来）。
 *
 * 这个缺陷已经发生三次，三次都是靠人眼维护 vendor/channel-pack/src/channel-pack-store.ts
 * 的 REF_PREFIX_TO_PROVIDER 掉队造成的 —— 前两次是漏加一行（minimax 2026-10-02、
 * opencode 2026-10-01），第三次之前这张表一开始就只摘了 6 项、少了 5 个 provider
 * （见 channel-pack-store.ts:319-322），到 gemini（2026-10-03）已经是第三次复发。
 * 原先的守卫是一个指向
 * tests/unit/channel-pack-store.spec.ts 的注释 —— 那个文件在本仓库从不存在，
 * 所以「合并新增 provider 的分支前先跑它」从未真正可执行。
 *
 * 这里把守卫落到真实的恢复路径上：不 import 那张私有表，而是直接跑
 * FileStore 的 bootstrapFromCredentialRefs（状态文档不存在时用 .credentials.yaml
 * 的 refs: 段重建账号索引），断言每个客户端 provider 都能被恢复出来。
 *
 * Run: node scripts/channel-providers-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href
const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
const ts = (await import('typescript')).default

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) return { url: kernel, shortCircuit: true }
    // 只给渠道包内部做 .js → .ts 解析，与 channel-registry-test.mjs 同款。
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

/**
 * 从 client.js 的 CHANNEL_PROVIDERS 声明里取 provider id。
 *
 * 刻意读源码而不是复制一份清单：复制的那份才是会漂移的东西。
 */
function clientProviderIds() {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const start = source.indexOf('const CHANNEL_PROVIDERS = [')
  assert.ok(start >= 0, 'client.js 仍然声明了 CHANNEL_PROVIDERS')
  const end = source.indexOf('\n    ]', start)
  assert.ok(end > start, 'CHANNEL_PROVIDERS 是一段可以从源码里切出来的数组')
  const block = source.slice(start, end)
  const ids = [...block.matchAll(/\{ id: '([a-z0-9]+)',/g)].map(match => match[1])
  // 不写「至少 10 项」这类手抄下限：那份数字会漂移，而漂移正是本文件要挡的东西。
  assert.ok(ids.length > 0, '客户端清单解析出了至少一个 provider')
  return ids
}

const store = await import('../vendor/channel-pack/src/channel-pack-store.ts')

/**
 * 一次真实的恢复：写一份只含 refs: 的 .credentials.yaml，让 FileStore 从中
 * 重建账号索引 —— 这正是「新增 provider 漏登记」时静默丢账号的那条路径。
 */
function recoverFromCredentialRefs(providerIds) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-provider-refs-'))
  const refs = providerIds.map(id => `  ${id.toUpperCase()}_ACCOUNT_ABCDEF:`)
  fs.writeFileSync(
    path.join(home, '.credentials.yaml'),
    `refs:\n${refs.join('\n')}\n`,
  )
  const saved = process.env.DSH_CHANNEL_PACK_STATE_DIR
  process.env.DSH_CHANNEL_PACK_STATE_DIR = home
  try {
    const value = store.createChannelPackStore({ logger: { warn() {}, info() {} } }).load()
    assert.ok(value !== undefined, 'bootstrap 从 refs: 里恢复出了一个状态文档')
    return value.accounts
  } finally {
    if (saved === undefined) delete process.env.DSH_CHANNEL_PACK_STATE_DIR
    else process.env.DSH_CHANNEL_PACK_STATE_DIR = saved
    fs.rmSync(home, { recursive: true, force: true })
  }
}

const ids = clientProviderIds()
const recovered = recoverFromCredentialRefs(ids)
const recoveredByProvider = new Map(recovered.map(account => [account.provider, account]))

/**
 * 第 ① 条：客户端展示的每个 provider 都必须能被恢复。
 *
 * 失败信息直接告诉维护者该改哪一行 —— 这条失败的后果是「用户重装后账号面板变空」，
 * 不是「某个按钮颜色不对」。
 */
check('every client provider survives a state.json-less recovery', () => {
  const missing = ids.filter(id => !recoveredByProvider.has(id))
  assert.deepEqual(
    missing, [],
    `这些 provider 在 .credentials.yaml 里认不出来（往 channel-pack-store.ts 的 REF_PREFIX_TO_PROVIDER 补一行）：${missing.join(', ')}`,
  )
  assert.equal(recovered.length, ids.length, '恢复出的账号数与客户端 provider 数相同（refs 没有被误归属到别的 provider）')
})

/**
 * 第 ② 条：只存在于恢复表、不在客户端清单里的 provider 必须是**有意的**。
 *
 * opencode 走条件装配（index.ts 的 modelAdapters 里 `...(opencodeAdapter === undefined
 * ? {} : { opencode: ... })`），没有账号时整个 provider 不注册，因此不出现在客户端清单。
 * 集合差一旦变化就得有人看一眼，而不是悄悄多出一个没人渲染的 provider。
 */
check('the table-only providers are the known conditional ones', () => {
  const extra = store.SUPPORTED_PROVIDERS.filter(id => !ids.includes(id)).sort()
  assert.deepEqual(
    extra, ['opencode'],
    '只有 opencode 是「表里有、客户端不渲染」的条件装配 provider；新增的 extra provider 请确认它是否该进 client.js',
  )
})

/**
 * 第 ③ 条：同前缀的 provider 必须归属正确（QODERCN 不能被认成 QODER）。
 *
 * 恢复正则按前缀长度降序排列才有这个性质；顺序错了不会报错，只会把 CN 的凭据
 * 挂到国际版面板上，请求必然失败。
 */
check('a longer prefix wins over a shorter one', () => {
  const accounts = recoverFromCredentialRefs(['qoder', 'qodercn'])
  const byProvider = new Map(accounts.map(account => [account.provider, account]))
  assert.equal(byProvider.get('qodercn')?.credentialRef, 'QODERCN_ACCOUNT_ABCDEF', 'QODERCN 前缀归 qodercn')
  assert.equal(byProvider.get('qoder')?.credentialRef, 'QODER_ACCOUNT_ABCDEF', 'QODER 前缀归 qoder')
})

check('unknown providers are rejected instead of silently accepted', () => {
  assert.equal(store.isSupportedProvider('trae'), true, '已登记的 provider 通过')
  assert.equal(store.isSupportedProvider('not-a-provider'), false, '未登记的 provider 被拒绝')
  assert.equal(store.isSupportedProvider(undefined), false, '非字符串被拒绝')
})

console.log(`channel-providers: ${checks} checks passed`)
