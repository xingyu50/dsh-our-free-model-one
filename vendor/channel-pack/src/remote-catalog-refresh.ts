/**
 * 手动强制重拉远端模型目录：只有与当前缓存**不一致**才覆盖。
 *
 * 既有的「成功即永久缓存」保持不变；本模块补的是一个显式入口：用户想
 * 知道上游有没有换模型时，重新问一次上游，把结果与现在这份缓存按 id
 * 逐条比对 —— 只有真不一样（新增/下架/改名/倍率或上下文变化）才替换
 * 缓存并通知界面刷新。上游返回空、请求失败、或只是顺序变化，都不动缓存，
 * 界面也不会因此少模型（这正是「手动拉取的与本地缓存的不一致才覆盖」）。
 *
 * 所有走 {@link RemoteCatalogGate} 的渠道共用这一份逻辑，避免各写一份
 * 「重拉→比对→覆盖」而迟早分叉。
 */

import type { RemoteCatalogGate } from './remote-catalog-gate.js'

/** 稳定序列化：对象键排序、忽略 `undefined`，供两份目录逐条比对。 */
function canonical(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}

/**
 * 以 id 为准比较两份目录；**纯顺序变化不算「上游换了模型」**。
 * 缓存为空（从未成功拉过）时，只要拿到非空目录即视为变化，以便手动刷新
 * 能从「开机那次失败」里恢复，而不必重启。
 */
export function remoteCatalogChanged<T extends { id: string }>(
  cached: readonly T[] | undefined,
  next: readonly T[],
): boolean {
  if (cached === undefined) return next.length > 0
  if (cached.length !== next.length) return true
  const before = new Map(cached.map((model) => [model.id, canonical(model)]))
  return next.some((model) => before.get(model.id) !== canonical(model))
}

export interface RemoteCatalogRefreshResult {
  /** 目录内容发生变化，调用方需广播界面刷新。 */
  changed: boolean
  /** 本次确实拿到了非空的上游目录；false = 上游失败/空结果，缓存未动。 */
  upstreamOk: boolean
}

export interface RemoteCatalogRefreshAdapter<T extends { id: string }> {
  readonly gate: RemoteCatalogGate
  /** 真正向上游发起请求。 */
  readonly fetch: () => Promise<readonly T[]> | readonly T[]
  /** 当前已落地的远端目录（不是兜底表）。 */
  cached: () => readonly T[] | undefined
  /** 首次加载与强制刷新共用的加工（如兜底表校正、models.dev 合并）。 */
  transform?: (models: readonly T[]) => readonly T[] | Promise<readonly T[]>
  /** 覆盖缓存及其派生结构。 */
  commit: (models: readonly T[]) => void
}

/**
 * 绕过冷却立即重拉；返回是否变化 / 是否连上上游。
 * 上游失败或空目录：不动缓存、不清成功状态，按目录闸门既有规则冷却。
 */
export async function forceRefreshRemoteCatalog<T extends { id: string }>(
  adapter: RemoteCatalogRefreshAdapter<T>,
): Promise<RemoteCatalogRefreshResult> {
  let changed = false
  let upstreamOk = false
  await adapter.gate.run(async () => {
    let models: readonly T[]
    try {
      models = await adapter.fetch()
    } catch {
      return false
    }
    if (models.length === 0) return false
    upstreamOk = true
    const next = adapter.transform === undefined ? models : await adapter.transform(models)
    if (remoteCatalogChanged(adapter.cached(), next)) {
      adapter.commit(next)
      changed = true
    }
    return true
  }, true)
  return { changed, upstreamOk }
}
