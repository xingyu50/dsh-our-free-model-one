/**
 * MiniMax Code（中国版）渠道的装配描述。
 *
 * 本文件是 `index.ts` 中原 MiniMax 装配块的**原样搬运**（options 与注释逐字保留），
 * 只把宿主依赖（账号池、图片桥接、上下文）改成注册表注入。
 *
 * @module channels/minimax
 */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { MinimaxAuth } from '../minimax-auth.js'
import { registerMinimaxLlm } from '../minimax-adapter.js'
import { MINIMAX } from '../minimax-product.js'
import type { MinimaxCredential, MinimaxModelEntry } from '../minimax.js'
import type { AccountPool } from '../account-pool.js'
import type { ChannelAuthInstance, ChannelHost, ChannelSpec } from '../channel-registry.js'
import { reportLedgerAccount } from '../token-ledger.js'

/** MiniMax 的 Auth 在注册表最小接口之外的额外能力。 */
export interface MinimaxChannelAuth extends ChannelAuthInstance {
  refreshAccountCredential(ref: string, pool: AccountPool, accountId: string): Promise<void>
  refresh(): Promise<void>
  fetchRemoteModelsOnly(pool?: AccountPool): Promise<readonly MinimaxModelEntry[]>
  refreshAll(pool: AccountPool): Promise<void>
}

/** 装配期需要、但不属于 `ChannelHost` 的依赖。 */
export interface MinimaxChannelDeps {
  readonly pool: AccountPool
}

/**
 * @param deps - 账号池
 * @returns 供 `mountChannels` 装配的 spec
 */
export function createMinimaxChannel(deps: MinimaxChannelDeps): ChannelSpec {
  const { pool } = deps
  let authContext: Context = undefined as unknown as Context
  let minimax: MinimaxAuth | undefined
  return {
    id: MINIMAX.id,
    namespace: 'llm-minimax',
    createAuth: (ctx) => {
      authContext = ctx
      minimax = new MinimaxAuth(ctx)
      return minimax as unknown as ChannelAuthInstance
    },
    registerLlm: (ctx: Context, host: ChannelHost) => {
      const minimaxAuth = minimax as unknown as MinimaxChannelAuth
      return registerMinimaxLlm(ctx, {
        credentialRef: credentialRef(MINIMAX.defaultCredentialRef),
        resolveCredential: async (modelId?: string) => {
          // provider 实参用 MINIMAX.id 而非字面量：写死字面量在改名/多产品场景下

          // ⚠️ 只从 minimax 自己的账号池取账号，回退到自己的单凭据 ref，
          // 保证不会串用其它 provider 的凭据。
          const available = await pool.getAvailableAccount(MINIMAX.id, modelId ?? '')

          // 联合（历史遗留），与 `MinimaxCredential` 无充分重叠，故经 `unknown` 转换。
          // 运行时安全性由 provider 过滤保证：查询用 `MINIMAX.id`，取到的必是 minimax 凭据。
          if (available) {
            // Token 账本（第 2 期）：回报「本笔请求解析出的账号」。
            reportLedgerAccount(MINIMAX.id, available.entry.id)
            return available.credential as unknown as MinimaxCredential
          }
          const resolved = await authContext.credentials.resolve(credentialRef(MINIMAX.defaultCredentialRef))
          if (!resolved) return undefined
          try {
            return JSON.parse(resolved.value) as MinimaxCredential
          } catch {
            return undefined
          }
        },
        refresh: async () => {
          // ⚠️ MiniMax **有** refresh 端点（`/oauth2/token` 的 refresh_token 授权），
          // 这里是真续期（与 Loomy 的「只能探测有效性」不同）。
          //
          // 仍须刷新**解析凭据时所用的那一个**账号，而不是默认单凭据 ref ——
          // 否则续期的是另一份凭据，用户会看到「刚登录好却一直认证失败」。
          const available = await pool.getAvailableAccount(MINIMAX.id, '')
          if (available) {
            // ⚠️ **必须传 pool + entry.id**：续期成功后要把新的 `expiresAt` 写回
            // 账号池，否则 UI 会一直显示「已过期」而实际能正常发消息
            //（真实缺陷：JWT 已续到 15:09、账号池仍是 12:02，相差 3.1 小时）。
            //
            // ⚠️ `getAvailableAccount` 返回 **`{ entry, credential }`** 两层 ——
            // 账号 id 与 credentialRef 在 **`available.entry`** 里，**不是**
            // `available.id` / `available.credentialRef`（那是 `undefined`，
            // 会让续期**静默写不回账号池**）。
            await minimaxAuth.refreshAccountCredential(
              available.entry.credentialRef, pool, available.entry.id,
            )
          } else {
            await minimaxAuth.refresh()
          }
        },
        // 远端模型目录：委托给 MinimaxAuth.fetchModels（它负责 Bearer 头 + 信封解析）。
        // ⚠️ **必须走远端** —— 客户端内置静态表只有 3 个模型，远端下发 4 个，
        // 照抄内置表会漏掉 `MiniMax-M3.1-Flash-Preview`（用户截图里选中的那个）。
        // 失败时返回兜底表（适配器侧也有兜底）。
        fetchRemoteModels: () => minimaxAuth.fetchRemoteModelsOnly(pool),
        // 图片字节桥接：模态按模型判定（远端 `modalities.input` 含 image，
        // 只有 M3.1-Flash-Preview 与 M3 是）。适配器声明不支持时会**报错**，
        // 不会把图片发出去让服务端 400。
        // ⚠️ 实测 MiniMax 收 **裸 base64** 的 Anthropic `image.source.base64`
        // （OpenAI 的 `image_url` 形状被服务端明确拒绝）。
        // ⚠️ 暂**不接** `readImageRequest` 缩放桥接：MiniMax 的单图上限是
        // 10 MiB（远端 `capabilities.max_image_bytes_inline`），未实测过超限行为，
        // 不凭猜测加一层（Qoder/Raccoon 是**实测撞了体积限制**才接的）。
        readImage: host.readImage,
        accountPool: pool,
        product: MINIMAX,
      })
    },
    refreshAll: async (target) => {
      await (minimax as unknown as MinimaxChannelAuth | undefined)?.refreshAll(target)
    },
  }
}
