#!/usr/bin/env node
// 一键启动 Our Free Model 独立本地服务。
//
// 按 PACKAGING.md 的文档流程串联三步：
//   1. npm ci（根 + packages/standalone）
//   2. node scripts/build-standalone-ui.mjs（构建前端）
//   3. node packages/standalone/cli.mjs（启动，前台运行，Ctrl+C 退出）
//
// 本脚本不认识的参数（如 --port / --data-dir / --lan）会原样透传给 cli.mjs。
//
// 用法：
//   node scripts/start-standalone.mjs [选项] [cli 参数...]
//     --skip-install   强制跳过 npm ci（默认：node_modules 已存在会自动跳过）
//     --force-install  即使已安装也强制 npm ci 重装
//     --skip-build     跳过前端构建（前端无变化时省时间）
//     --dry-run        只打印将要执行的命令，不真正运行
//     --help, -h       显示帮助

import { spawnSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, '..')
const STANDALONE = path.join(ROOT, 'packages', 'standalone')
const CLI = path.join(STANDALONE, 'cli.mjs')
const BUILD_UI = path.join(ROOT, 'scripts', 'build-standalone-ui.mjs')

const ORCHESTRATOR_FLAGS = new Set(['--skip-install', '--force-install', '--skip-build', '--dry-run', '--help', '-h'])

const argv = process.argv.slice(2)
const forceInstall = argv.includes('--force-install')
const skipInstall = argv.includes('--skip-install')
const skipBuild = argv.includes('--skip-build')
const dryRun = argv.includes('--dry-run')
const help = argv.includes('--help') || argv.includes('-h')
// 本脚本不消费的参数，原样透传给 cli.mjs。
const forwarded = argv.filter((a) => !ORCHESTRATOR_FLAGS.has(a))

const helpText = [
  'Our Free Model 一键启动脚本',
  '用法：node scripts/start-standalone.mjs [选项] [cli 参数...]',
  '',
  '  选项（本脚本消费，不传给 cli）：',
  '    --skip-install   强制跳过 npm ci（默认：node_modules 已存在会自动跳过）',
  '    --force-install  即使已安装也强制 npm ci 重装',
  '    --skip-build     跳过前端构建',
  '    --dry-run        只打印将要执行的命令',
  '    --help, -h       显示本帮助',
  '',
  '  其余参数（如 --port / --data-dir / --lan / --no-refresh 等）',
  '  原样透传给 packages/standalone/cli.mjs。',
  '',
  '  默认行为：检测到根与 packages/standalone 的 node_modules 均已存在时，',
  '  自动跳过 npm ci；想强制重装用 --force-install。',
  '',
].join('\n')

if (help) {
  process.stdout.write(helpText + '\n')
  process.exit(0)
}

// 检查 Node 版本（engines: ^22.19.0 || >=24.0.0）。
const [major, minor] = process.versions.node.split('.').map(Number)
const nodeOk = (major === 22 && minor >= 19) || major >= 24
if (!nodeOk) {
  process.stderr.write(
    '警告：当前 Node 版本为 ' + process.versions.node + '，本服务要求 ^22.19.0 或 >=24.0.0。' + '\n' +
    '  继续运行可能失败，请先升级 Node。' + '\n'
  )
}

// ---- 启动前预检：数据目录是否已被另一个实例占用 -------------------------
// cli.mjs 会抛 EEXIST，但那时用户已经等完 npm ci 和前端构建。这里提前失败，
// 并说明「这不是闪退，是设计上拒绝接管」。
function resolveDataDir(list) {
  const i = list.indexOf('--data-dir')
  // 少数调用方式会把引号原样带进参数，这里去掉首尾引号再解析。
  if (i !== -1 && list[i + 1]) return path.resolve(list[i + 1].replace(/^"(.*)"$/, '$1'))
  if (process.env.OFM_HOME) return path.resolve(process.env.OFM_HOME)
  return path.join(os.homedir(), '.our-free-model')
}

const dataDir = resolveDataDir(forwarded)
try {
  const owner = JSON.parse(fs.readFileSync(path.join(dataDir, 'service.lock'), 'utf8'))
  if (owner?.product === 'our-free-model-standalone' && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
    let alive = false
    try { process.kill(owner.pid, 0); alive = true }
    catch (probe) { alive = probe.code !== 'ESRCH' }   // 只有 ESRCH 能证明进程已退出
    if (alive) {
      process.stderr.write(
        '\n✖ 数据目录已被另一个服务实例占用，本次不启动。\n' +
        '  数据目录：' + dataDir + '\n' +
        '  占用进程：pid ' + owner.pid + '（our-free-model-standalone）\n' +
        '\n' +
        '  这不是闪退：同一数据目录已有实例运行时，服务按设计拒绝接管，\n' +
        '  既不抢占也不删除它的锁。任选一种处理方式：\n' +
        '    1. 先退出正在运行的实例（桌面壳在托盘菜单选「退出」），再重试；\n' +
        '    2. 换一个数据目录：node scripts/start-standalone.mjs --data-dir D:\\ofm-data\n' +
        '    3. 直接使用已经在运行的那个实例。\n\n'
      )
      if (!dryRun) process.exit(1)
    } else {
      process.stdout.write('· 检测到陈旧锁（pid ' + owner.pid + ' 已退出），启动时自动回收。\n')
    }
  }
} catch (readerError) {
  // 没有锁文件，或锁内容不是本产品/无法解析：交给 cli.mjs 按原逻辑处理。
  if (readerError.code !== 'ENOENT' && !(readerError instanceof SyntaxError)) throw readerError
}

function run(name, cmd, cmdArgs, opts = {}) {
  const cwd = opts.cwd || ROOT
  if (dryRun) {
    process.stdout.write('[dry-run] ' + name + ': ' + cmd + ' ' + cmdArgs.join(' ') + ' (cwd=' + cwd + ')\n')
    return 0
  }
  process.stdout.write('\n▶ ' + name + '\n')
  const res = spawnSync(cmd, cmdArgs, { stdio: 'inherit', cwd, shell: true })
  if (res.error) {
    process.stderr.write('✖ ' + name + ' 无法执行：' + res.error.message + '\n')
    process.exit(1)
  }
  if (res.status !== 0) {
    process.stderr.write('✖ ' + name + ' 失败（退出码 ' + (res.status ?? '?') + '）\n')
    process.exit(res.status || 1)
  }
  return res.status
}

// ---- 依赖安装：node_modules 已存在则自动跳过 ----------------------------
function nodeModulesPresent(dir) {
  try {
    const st = fs.statSync(path.join(dir, 'node_modules'))
    return st.isDirectory()
  } catch { return false }
}

// 决定是否需要安装。优先级：--skip-install > --force-install > 自动探测。
// 根与 standalone 任一缺失都算「需要安装」。
let needInstall
if (skipInstall) needInstall = false
else if (forceInstall) needInstall = true
else needInstall = !(nodeModulesPresent(ROOT) && nodeModulesPresent(STANDALONE))

if (needInstall) {
  // Only the case the user did not ask for is worth a line: an auto-install takes
  // minutes and they should know why. --force-install / --skip-install are
  // echoes of what they just typed.
  if (!forceInstall && !skipInstall) process.stdout.write('· 未检测到完整的 node_modules，自动安装依赖。\n')
  // 这个仓库的 lockfile 把部分包解析到 registry.npmmirror.com，与默认 registry
  // (registry.npmjs.org) 不一致时，npm 会把这些注册表 tarball 归为 type=remote，
  // 一旦环境策略关闭了 allow-remote 就会以 EALLOWREMOTE 失败。
  // CLI 参数优先级高于 npmrc 与环境变量，显式放开即可绕开该判定。
  run('安装根依赖', 'npm', ['ci', '--allow-remote=all'], { cwd: ROOT })
  run('安装 standalone 依赖', 'npm', ['ci', '--allow-remote=all'], { cwd: STANDALONE })
}

if (!skipBuild) run('构建前端', 'node', [BUILD_UI], { cwd: ROOT })

if (dryRun) {
  process.stdout.write('[dry-run] 启动：' + process.execPath + ' ' + CLI + ' ' + forwarded.join(' ') + '\n')
  process.exit(0)
}

process.stdout.write('\n▶ 启动独立本地服务（Ctrl+C 退出）\n')
const child = spawn(process.execPath, [CLI, ...forwarded], { stdio: 'inherit', cwd: ROOT })
child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0))
})
const forward = (sig) => { try { child.kill(sig) } catch { /* 已退出 */ } }
process.on('SIGINT', () => forward('SIGINT'))
process.on('SIGTERM', () => forward('SIGTERM'))
