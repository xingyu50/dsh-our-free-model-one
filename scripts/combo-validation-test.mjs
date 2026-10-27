#!/usr/bin/env node
/**
 * Combo（链路）定义的合法性：成环的链路必须在**保存时**被拒绝。
 *
 * 背景：两个管理边界对同一份输入给出不同答案。独立端
 * （packages/standalone/routing.mjs:36）在写入前跑 ensureAcyclic，遇到环抛错；
 * 插件端（index.js 的 combos.save）只做 normalizeCombos + 落盘，不校验环。
 *
 * 后果不是「两边不一致」这么轻：插件端能把成环的 combo 写进 settings.json，
 * 而渲染期 src/combos.js:112 的 buildComboCatalog 遇到环**静默丢弃**它。
 * 用户看到的是「刚保存的链路不见了」，且没有任何错误提示。
 *
 * 本测试只覆盖纯函数 ensureAcyclic，不启动服务。
 *
 * Run: node scripts/combo-validation-test.mjs
 */
import assert from 'node:assert/strict'
import { ensureAcyclic } from '../src/combos.js'

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

const combo = (id, models) => ({ id, name: id.slice('combo:'.length), models, strategy: 'fallback', stickyLimit: 1, enabled: true })

check('an empty list is acyclic', () => {
  assert.doesNotThrow(() => ensureAcyclic([]))
})

check('a chain over real models is acyclic', () => {
  assert.doesNotThrow(() => ensureAcyclic([
    combo('combo:a', ['model-1', 'model-2']),
    combo('combo:b', ['model-3']),
  ]))
})

check('a chain that names another chain is acyclic', () => {
  assert.doesNotThrow(() => ensureAcyclic([
    combo('combo:a', ['model-1']),
    combo('combo:b', ['combo:a', 'model-2']),
  ]))
})

check('a two-link cycle is refused', () => {
  assert.throws(() => ensureAcyclic([
    combo('combo:a', ['combo:b']),
    combo('combo:b', ['combo:a']),
  ]), /循环引用/, 'a->b->a must be refused')
})

check('a self-reference is refused', () => {
  assert.throws(() => ensureAcyclic([combo('combo:a', ['combo:a'])]), /循环引用/)
})

check('a three-link cycle is refused', () => {
  assert.throws(() => ensureAcyclic([
    combo('combo:a', ['combo:b']),
    combo('combo:b', ['combo:c']),
    combo('combo:c', ['combo:a']),
  ]), /循环引用/)
})

check('a cycle reaches the caller as a 400-status error', () => {
  // 与独立端同款：抛出带 statusCode 的错误，管理 API 的统一 catch 会把它
  // 渲染成 HTTP 400，而不是 500。
  try {
    ensureAcyclic([combo('combo:a', ['combo:b']), combo('combo:b', ['combo:a'])])
    assert.fail('expected ensureAcyclic to throw')
  } catch (error) {
    assert.equal(error.statusCode, 400, 'the refusal is a client error, not a server error')
  }
})

check('reference to a combo that does not exist is not a cycle', () => {
  // 指向尚未定义的链路是允许的：链路可能引用一个当前被关闭的模型。
  // index.js 的 save 注释明确保留这一点，环检测不应顺手把它拒掉。
  assert.doesNotThrow(() => ensureAcyclic([combo('combo:a', ['combo:missing', 'model-1'])]))
})

console.log(failures > 0
  ? `combo-validation-test: ${failures} failure(s)`
  : 'combo-validation-test: a cyclic chain is refused at save time and a dangling link is not')
process.exitCode = failures > 0 ? 1 : 0
