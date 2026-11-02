#!/usr/bin/env node
/**
 * 只读地看一眼渠道包的运行时状态：账号、按模型的解禁时刻、锁定永久积分。
 *
 * ## 为什么需要它
 *
 * 这些状态住在两个 JSON 文档里（`state.json` 与 `permanent-locks.json`），
 * 而「为什么这次没选这个号 / 为什么这个号在冷却」只能从里面读出来。此前唯一的
 * 入口是面板 —— 面板要跑起来、要登录、还要点进对应 provider 才看得见，命令行里
 * 完全无法回答（本机实测 `~/.dsh/channel-pack` 长期不存在，因为桌面端把状态写在
 * 另一个 home 里，用户根本不知道去哪找）。
 *
 * ## 只读
 *
 * 本脚本**不写任何文件**，也不 import 渠道包源码（那需要 registerHooks +
 * typescript 转译）。home 的解析就地复刻 `vendor/channel-pack/src/channel-pack-store.ts`
 * 的 `resolveChannelPackHome`，但只复刻**三级**（见 resolveHome） —— 复刻而不是 import，是因为那几条判断本身
 * 稳定（改它会同时影响七八个状态文档，代价远大于收益），而多引入一条转译链会让
 * 「排查一个显示问题」变成「先修一个转译问题」。
 *
 * Run: node scripts/channel-pack-state.mjs [--json]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const jsonMode = process.argv.includes('--json')

/**
 * 与 `channel-pack-store.ts` 的 `resolveChannelPackHome` 同序，但只有三级：
 * 显式覆盖 → `$DSH_HOME` → `~/.dsh`。
 *
 * ⚠️ 源码里的优先级是**四**级，本脚本缺的那一级是 `ctx.profileContext.home` ——
 * 它由运行期注入，命令行里拿不到。当 profile home 与 `$DSH_HOME` **不相等**时，
 * 本脚本显示的是 `$DSH_HOME` 那一份，可能不是面板实际读写的那一份；要核对就用
 * `DSH_CHANNEL_PACK_STATE_DIR` 直接指过去。
 */
function resolveHome() {
  const override = process.env.DSH_CHANNEL_PACK_STATE_DIR
  if (override !== undefined && override.trim().length > 0) return override.trim()
  const envHome = process.env.DSH_HOME
  if (envHome !== undefined && envHome.trim().length > 0) return envHome.trim()
  return path.join(os.homedir(), '.dsh')
}

function readJson(file) {
  try {
    return { exists: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, value: undefined }
    return { exists: true, value: undefined, error: String(error) }
  }
}

/**
 * 状态文档被半写坏是常规形态（升级中断、编辑器截断），排查脚本不能先崩。
 * 任何非字符串的字段都按空串显示，空供应商名至少还能看出「这里有个账号」。
 */
function asText(value) {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
}

/** `permanent-locks.json` 兼容带 schema 与裸表两种形态（见 permanent-lock-store.ts 的 locksFieldOf）。 */
function locksOf(parsed) {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const record = parsed
  const field = record.locks !== undefined ? record.locks : record.schema === undefined ? record : {}
  if (typeof field !== 'object' || field === null || Array.isArray(field)) return {}
  const locks = {}
  for (const [provider, value] of Object.entries(field)) if (value === true) locks[provider] = true
  return locks
}

/**
 * 把毫秒时间戳写成「还剩 12 分 / 已过」，比裸时间戳好读。
 *
 * 两种截止时刻的措辞必须分开：解禁说「已解禁」，凭据到期说「已过期」。曾经两者
 * 共用「已解禁」，于是过了期的凭据也会显示成「已解禁」—— 而这两件事在排查里
 * 方向相反（解禁是等一会儿就好，过期是要重新登录）。
 */
function describeDeadline(atMs, now, expiredLabel) {
  if (!Number.isFinite(atMs)) return String(atMs)
  if (atMs === 0) return '（未标记）'
  const delta = atMs - now
  const when = new Date(atMs).toLocaleString()
  if (delta <= 0) return `${when}（${expiredLabel}）`
  const minutes = Math.ceil(delta / 60_000)
  const human = minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分` : `${minutes} 分`
  return `${when}（还剩 ${human}）`
}

const now = Date.now()
const home = resolveHome()
const directory = path.join(home, 'channel-pack')
const stateFile = path.join(directory, 'state.json')
const locksFile = path.join(directory, 'permanent-locks.json')
const state = readJson(stateFile)
const locksDoc = readJson(locksFile)

const accounts = Array.isArray(state.value?.accounts) ? state.value.accounts.filter(a => typeof a === 'object' && a !== null) : []
const locks = locksOf(locksDoc.value)
const disabledModels = state.value?.disabledModels
const report = {
  home,
  stateFile,
  stateExists: state.exists,
  locksFile,
  locksExists: locksDoc.exists,
  gatewayEnabled: state.value?.gatewayEnabled,
  providerOrder: state.value?.providerOrder,
  permanentLocks: locks,
  legacyLoomyMirror: state.value?.loomyPermanentLocked === true,
  accounts: accounts.map(account => ({
    id: account.id,
    provider: account.provider,
    nickname: account.nickname,
    enabled: account.enabled !== false,
    credentialRef: account.credentialRef,
    expiresAt: account.expiresAt,
    rateLimits: Object.fromEntries(
      Object.entries(account.modelRateLimits ?? {}).map(([model, atMs]) => [model, { atMs, text: describeDeadline(atMs, now, '已解禁') }]),
    ),
  })),
  disabledModels,
}

if (jsonMode) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`状态目录     ${directory}`)
  console.log(state.exists ? `state.json   ${stateFile}` : `state.json   ${stateFile}（不存在：账号池还没落盘过，或用的是 settings 后端）`)
  if (state.error !== undefined) console.log(`  ⚠ 读取失败：${state.error}`)
  console.log(locksDoc.exists ? `锁定表       ${locksFile}` : `锁定表       ${locksFile}（不存在）`)
  // 「读不懂」和「没锁」是两件事：不报这一行，一份坏掉的锁定表会被读成「没有任何 provider 锁定」。
  if (locksDoc.error !== undefined) console.log(`  ⚠ 读取失败：${locksDoc.error}`)
  const locked = Object.keys(locks)
  const lockText = locksDoc.error !== undefined ? '（读不出来，见上）' : locked.length === 0 ? '（无）' : locked.join(', ')
  console.log(`锁定永久积分 ${lockText}`)
  if (report.legacyLoomyMirror && locks.loomy !== true) {
    console.log('  ⚠ state.json 里 loomyPermanentLocked=true 只是镜像，权威表里没锁 —— 以锁定表为准')
  }
  const gateway = state.value?.gatewayEnabled
  console.log(`本地网关     ${gateway === undefined ? '（未写入，默认启用）' : gateway ? '启用' : '停用'}`)
  const order = state.value?.providerOrder
  console.log(`provider 顺序 ${Array.isArray(order) && order.length > 0 ? order.join(' > ') : '（未自定义，按声明顺序）'}`)
  console.log('')
  if (accounts.length === 0) {
    console.log('账号         （空）')
  } else {
    console.log(`账号         ${accounts.length} 个`)
    for (const account of report.accounts) {
      const flag = account.enabled ? '' : '（已停用）'
      const expiry = typeof account.expiresAt === 'number' ? ` · 凭据到期 ${describeDeadline(account.expiresAt, now, '已过期')}` : ''
      const provider = asText(account.provider) || '（无 provider）'
      console.log(`  ${provider.padEnd(10)} ${asText(account.id) || '（无 id）'} · ${asText(account.nickname)}${flag}${expiry}`)
      for (const [model, entry] of Object.entries(account.rateLimits)) console.log(`      ${model}: ${entry.text}`)
    }
  }
  const disabled = typeof disabledModels === 'object' && disabledModels !== null && !Array.isArray(disabledModels) ? Object.entries(disabledModels).filter(([, models]) => typeof models === 'object' && models !== null) : []
  console.log('')
  if (disabled.length === 0) console.log('停用模型     （无）')
  else {
    console.log('停用模型')
    for (const [provider, models] of disabled) console.log(`  ${provider}: ${Object.keys(models).join(', ')}`)
  }
}
