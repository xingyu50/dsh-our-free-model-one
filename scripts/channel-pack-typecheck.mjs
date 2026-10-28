#!/usr/bin/env node
/**
 * 渠道包的类型检查，按**基线**判定，而不是「零错误」。
 *
 *     node scripts/channel-pack-typecheck.mjs            # 只报新增
 *     node scripts/channel-pack-typecheck.mjs --update   # 收紧基线
 *
 * 为什么不直接看 `tsc --noEmit` 的退出码：
 *
 * `vendor/channel-pack/` 在本检查引入**之前**就有 23 个类型错误
 * （openai-gateway/messages.ts 8、minimax-messages.ts 5、gemini-messages.ts 5、
 * openai-gateway/responses.ts 2、minimax-adapter.ts 1、gemini-adapter.ts 1、
 * channel-fetch.ts 1）。它们是既有问题，不属于任何一次具体改动。
 *
 * 一个「必然红」的检查等于没有检查：它会在第一次使用后就被跳过（`--no-verify`
 * 或干脆不跑）。所以这里冻结基线，只对**新增**错误报红 —— 与 test-all 里
 * magpie-policy 的 60 秒超时同一类处理：已知的既存问题不阻塞，新引入的必须挡。
 *
 * ⚠️ 直接调本地 tsc 的 bin，不走 `npx`：`npx.cmd` + `shell: false` 在
 * Windows 上不会真正执行，stdout 里只剩 "npm notice run …"，正则匹配到 0 条，
 * 检查会**假绿**。这个坑踩过一次。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(fileURLToPath(new URL('..', import.meta.url)))
const packDir = path.join(root, 'vendor/channel-pack')
const baselineFile = path.join(root, 'scripts/channel-pack-typecheck-baseline.json')

const result = spawnSync(
  process.execPath,
  [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json', '--noEmit'],
  { cwd: packDir, encoding: 'utf8' },
)

const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
// One line per error: "src/x.ts(12,3): error TS2322: …". The baseline records
// file + code only, so a line move does not churn it.
const current = [...output.matchAll(/^(src\/[^(]+)\((\d+),\d+\): error (TS\d+)/gm)]
  .map(match => `${match[1]}(${match[3]})`)
  .sort()

if (current.length === 0 && result.status !== 0) {
  // tsc failed without a parseable error line: report the raw output rather than
  // claim success. A silent 0 here is exactly the 假绿 this guard must not have.
  console.error('channel-pack typecheck: tsc 失败但输出无法解析')
  console.error(output.split('\n').slice(0, 20).join('\n'))
  process.exit(1)
}

const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'))
const known = new Set(baseline.errors)

if (process.argv.includes('--update')) {
  fs.writeFileSync(baselineFile, `${JSON.stringify({ note: baseline.note, errors: current }, null, 2)}\n`)
  console.log(`channel-pack typecheck: 基线已更新为 ${current.length} 条`)
  process.exit(0)
}

const introduced = current.filter(entry => !known.has(entry))
const fixed = baseline.errors.filter(entry => !current.includes(entry))

if (introduced.length > 0) {
  console.error('channel-pack typecheck: 新增类型错误')
  for (const entry of introduced) console.error(`  + ${entry}`)
  console.error('基线里的既有错误不算数，但新引入的必须修掉。')
  process.exit(1)
}

if (fixed.length > 0) {
  console.log(`channel-pack typecheck: 无新增错误；另有 ${fixed.length} 个基线错误已消失，可运行 --update 收紧：`)
  for (const entry of fixed) console.log(`  - ${entry}`)
  process.exit(0)
}

console.log(`channel-pack typecheck: 无新增错误（基线 ${baseline.errors.length} 条，当前 ${current.length} 条）`)
