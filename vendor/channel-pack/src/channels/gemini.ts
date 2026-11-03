/**
 * Gemini（Google Cloud Code Assist 免费线）渠道的装配描述。
 *
 * 本文件是 `index.ts` 中原 Gemini 装配块的**原样搬运**（options 与注释逐字保留），
 * 只把宿主依赖（账号池、渠道网络出口、图片桥接、上下文）改成注册表注入。
 *
 * @module channels/gemini
 */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { GeminiAuth } from '../gemini-auth.js'
import { registerGeminiLlm } from '../gemini-adapter.js'
import { GEMINI } from '../gemini.js'
import type { GeminiCredential } from '../gemini.js'
import { createGeminiSigStore } from '../gemini-sigstore.js'
import type { AccountPool } from '../account-pool.js'
import type { ChannelAuthInstance, ChannelHost, ChannelSpec } from '../channel-registry.js'
import { reportLedgerAccount } from '../token-ledger.js'

/** Gemini 的 Auth 在注册表最小接口之外的额外能力。 */
export interface GeminiChannelAuth extends ChannelAuthInstance {
  refreshAccountCredential(ref: string, pool: AccountPool, accountId: string): Promise<void>
  refresh(): Promise<void>
  repairAccountNicknames(pool: AccountPool): Promise<string[]>
  refreshAll(pool: AccountPool): Promise<void>
}

/** 装配期需要、但不属于 `ChannelHost` 的依赖。 */
export interface GeminiChannelDeps {
  readonly pool: AccountPool
  /** 渠道网络出口（用户代理设置必须生效，不能用全局 fetch）。 */
  readonly fetcher: typeof fetch
}

/**
 * @param deps - 账号池与渠道网络出口
 * @returns 供 `mountChannels` 装配的 spec
 */
export function createGeminiChannel(deps: GeminiChannelDeps): ChannelSpec {
  const { pool, fetcher } = deps
  let authContext: Context = undefined as unknown as Context
  let gemini: GeminiAuth | undefined
  let sigStore: ReturnType<typeof createGeminiSigStore> | undefined
  return {
    id: GEMINI.id,
    namespace: 'llm-gemini',
    createAuth: (ctx) => {
      authContext = ctx
      gemini = new GeminiAuth(ctx, { fetchImpl: fetcher })
      sigStore = createGeminiSigStore(ctx)
      return gemini as unknown as ChannelAuthInstance
    },
    registerLlm: (ctx: Context, host: ChannelHost) => {
      const geminiAuth = gemini as unknown as GeminiChannelAuth
      const geminiSigStore = sigStore as ReturnType<typeof createGeminiSigStore>
      // ⚠️ 项目号探测缓存必须**在这里建一次、长期复用** —— 每次 `stream()` 现造
      // 等于没有跨请求缓存，每轮推理都会多打一次 `loadCodeAssist`。
      const geminiProjectCache = new Map<string, string>()
      return registerGeminiLlm(ctx, {
        fetchImpl: fetcher,
        projectFetcher: fetcher,
        credentialRef: credentialRef(GEMINI.defaultCredentialRef),
        resolveCredential: async (modelId?: string) => {
          // ⚠️ provider 实参用 GEMINI.id 而非字面量（同 minimax 的既有约定：
          // 写死字面量在改名/多产品场景下会静默查不到账号）。
          const available = await pool.getAvailableAccount(GEMINI.id, modelId ?? '')
          // `getAvailableAccount` 的凭据类型是历史遗留的联合类型，与
          // `GeminiCredential` 无充分重叠，故经 `unknown` 转换；运行时安全性由
          // provider 过滤保证（查询用 `GEMINI.id`，取到的必是 gemini 凭据）。
          if (available) {
            // Token 账本（第 2 期）：回报「本笔请求解析出的账号」。
            reportLedgerAccount(GEMINI.id, available.entry.id)
            return available.credential as unknown as GeminiCredential
          }
          const resolved = await authContext.credentials.resolve(credentialRef(GEMINI.defaultCredentialRef))
          if (!resolved) return undefined
          try {
            return JSON.parse(resolved.value) as GeminiCredential
          } catch {
            return undefined
          }
        },
        refresh: async () => {
          // ⚠️ 必须刷新**解析凭据时所用的那一个**账号，而不是默认单凭据 ref ——
          // 否则续期的是另一份凭据，用户会看到「刚登录好却一直认证失败」。
          const available = await pool.getAvailableAccount(GEMINI.id, '')
          if (available) {
            // ⚠️ **必须传 pool + entry.id**：续期成功后要把新的 `expiresAt` 写回
            // 账号池，否则 UI 一直显示「已过期」而实际能正常发消息。
            // ⚠️ `getAvailableAccount` 返回 **`{ entry, credential }`** 两层 ——
            // 账号 id 与 credentialRef 在 **`available.entry`** 里，**不是**
            // `available.id` / `available.credentialRef`（那是 `undefined`，
            // 会让续期**静默写不回账号池**）。
            await geminiAuth.refreshAccountCredential(
              available.entry.credentialRef, pool, available.entry.id,
            )
          } else {
            await geminiAuth.refresh()
          }
        },
        // 模型表是**静态**的（用户拍板：不拉远端目录，Cloud Code 没有模型列表端点）。
        // 故这里不传 `fetchRemoteModels`。
        // 图片两跳：先按 640,000 px 预算取缩放版，拿不到才发原图。
        readImage: host.readImage,
        readImageRequest: host.readImageRequest,
        sigStore: geminiSigStore,
        accountPool: pool,
        product: GEMINI,
        // 项目号：缺省**自动探测**（`loadCodeAssist` 的 `cloudaicompanionProject`），
        // 不是恒为 `aicode-consumers`（那只是探测为空时的兜底）。
        projectCache: geminiProjectCache,
        persistProject: async (value: string) => {
          // ⚠️ 回写到**解析凭据时所用的那个账号**，不是默认单凭据 ref ——
          // 写错对象会让另一个账号的凭据被污染。
          const available = await pool.getAvailableAccount(GEMINI.id, '')
          const ref = available
            ? available.entry.credentialRef
            : credentialRef(GEMINI.defaultCredentialRef)
          await authContext.credentials.set(credentialRef(ref), value)
        },
        ...ctx.logger === undefined ? {} : { logger: ctx.logger },
      })
    },
    afterMount: (ctx) => {
      // 一次性修复**老 Gemini 账号**的展示名（同类，成因见 `gemini-auth.ts` 的
      // `repairAccountNicknames`）：旧版本解析令牌响应时丢掉了 `id_token`，身份只剩
      // userinfo 一次可静默失败的跨域请求，失败即让昵称退化成池 id（`gemini-6a53dbca`）。
      // 光改代码只影响新登录的账号，故这里主动补一次。
      //
      // ⚠️ 幂等 + 失败不阻塞启动（`repairAccountNicknames` 内部逐账号 catch）。
      void (gemini as unknown as GeminiChannelAuth).repairAccountNicknames(pool).then((repaired) => {
        if (repaired.length > 0) {
          ctx.logger.info(
            `[channel-pack] 已修正 ${repaired.length} 个 Gemini 账号的显示名（改用 Google 账号邮箱）：${repaired.join(', ')}`,
          )
        }
      }).catch((error: unknown) => {
        ctx.logger.warn(`[channel-pack] 修正 Gemini 账号显示名失败：${String(error)}`)
      })
    },
    refreshAll: async (target) => {
      await (gemini as unknown as GeminiChannelAuth | undefined)?.refreshAll(target)
    },
    dispose: () => {
      // 签名存储的落盘在卸载阶段补一次，失败静默（进程要退了）。
      void sigStore?.flush().catch(() => {})
    },
  }
}
