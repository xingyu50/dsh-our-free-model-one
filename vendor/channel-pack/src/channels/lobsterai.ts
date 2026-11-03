/**
 * LobsterAI（有道龙虾）渠道的装配描述。
 *
 * 本文件是 `index.ts` 中原 LobsterAI 装配块的**原样搬运**：options 内容与注释
 * 逐字保留，只把宿主依赖（账号池、图片桥接）改成注册表注入。
 *
 * @module channels/lobsterai
 */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LobsteraiAuth } from '../lobsterai-auth.js'
import { registerLobsteraiLlm } from '../lobsterai-adapter.js'
import { LOBSTERAI } from '../lobsterai-product.js'
import type { LobsteraiCredential } from '../lobsterai.js'
import type { LobsteraiRemoteModel } from '../lobsterai-adapter.js'
import type { AccountPool } from '../account-pool.js'
import type { ChannelAuthInstance, ChannelHost, ChannelSpec } from '../channel-registry.js'
import { reportLedgerAccount } from '../token-ledger.js'

/** LobsterAI 的 Auth 在注册表最小接口之外的额外能力。 */
export interface LobsteraiChannelAuth extends ChannelAuthInstance {
  refreshAccountCredential(ref: string, pool: AccountPool, accountId: string): Promise<void>
  refresh(): Promise<void>
  fetchModels(pool?: AccountPool): Promise<LobsteraiRemoteModel[]>
  resolveClientVersion(): Promise<string>
  refreshAll(pool: AccountPool): Promise<void>
  repairAccountNicknames(pool: AccountPool): Promise<string[]>
}

/** 装配期需要、但不属于 `ChannelHost` 的依赖。 */
export interface LobsteraiChannelDeps {
  readonly pool: AccountPool
}

export function createLobsteraiChannel(deps: LobsteraiChannelDeps): ChannelSpec {
  const { pool } = deps
  let authContext: Context = undefined as unknown as Context
  let auth: LobsteraiAuth | undefined
  return {
    id: LOBSTERAI.id,
    namespace: 'llm-lobsterai',
    createAuth: (ctx) => {
      authContext = ctx
      auth = new LobsteraiAuth(ctx)
      return auth as unknown as ChannelAuthInstance
    },
    registerLlm: (ctx: Context, host: ChannelHost) => {
      const lobsterai = auth as unknown as LobsteraiChannelAuth
      return registerLobsteraiLlm(ctx, {
        credentialRef: credentialRef(LOBSTERAI.defaultCredentialRef),
        resolveCredential: async (modelId?: string) => {
          // 只从 LobsterAI 自己的账号池取账号，回退到自己的单凭据 ref，
          // 保证不会串用其它 provider 的凭据。
          // provider 实参用 LOBSTERAI.id 而非字面量 'lobsterai'：写死字面量在
          // 改名/多产品场景下会静默查不到账号。
          const available = await pool.getAvailableAccount(LOBSTERAI.id, modelId ?? '')
          // Token 账本（第 2 期）：回报「本笔请求解析出的账号」。
          if (available) {
            reportLedgerAccount(LOBSTERAI.id, available.entry.id)
            return available.credential as LobsteraiCredential
          }
          const resolved = await authContext.credentials.resolve(credentialRef(LOBSTERAI.defaultCredentialRef))
          if (!resolved) return undefined
          try {
            return JSON.parse(resolved.value) as LobsteraiCredential
          } catch {
            return undefined
          }
        },
        refresh: async () => {
          // 必须刷新**解析凭据时所用的那一个**账号，而不是默认单凭据 ref。
          //
          // 为什么：resolveCredential（上面）优先从账号池取
          // `LOBSTERAI_ACCOUNT_XXX` 的凭据，而 `lobsterai.refresh()` 读写的是
          // `LOBSTERAI_ACCESS_TOKEN`。两者错配的后果是 —— 适配器检测到池凭据
          // 过期 → 调 refresh → 成功回写到**另一个** ref → 再 resolve 仍取到
          // 那份未更新的过期凭据 → 带着过期 token 发请求 → 401。
          // 用户看到的是「刚在 Channel Pack 登录好，却一直认证失败」，
          // 而日志里续期全是成功的，极难排查。
          //
          // 与 Go 一致：`handler.go:197-209` 也是先 Pick 出账号、再对该账号
          // `RefreshToken(acct)`（而非某个全局单例）。
          const available = await pool.getAvailableAccount(LOBSTERAI.id, '')
          if (available) await lobsterai.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id)
          else await lobsterai.refresh()
        },
        fetchRemoteModels: () => lobsterai.fetchModels(pool),
        resolveClientVersion: () => lobsterai.resolveClientVersion(),
        readImage: host.readImage,
        // 图片请求版本（缩放）桥接：issue !IKITT9。该家实测 13 张原图（≈50 MiB）
        // 就回 `SERVER code=500`，撞的是请求体体积。
        readImageRequest: host.readImageRequest,
        accountPool: pool,
        product: LOBSTERAI,
      })
    },
    // 一次性修复**老 LobsterAI 账号**的展示名（同类，但成因不同）：
    // 服务端把**手机号本身**当 `user.nickname` 下发，且只脱敏到「露末 4 位」
    // （`130****1100`）—— 按用户要求收敛为只露末 2 位（`130******00`）。
    // 纯本地归一化（幂等），无需重新登录。
    //
    // ⚠️ 幂等 + 失败不阻塞启动（`repairAccountNicknames` 内部逐账号 catch）。
    afterMount: (ctx) => {
      void (auth as LobsteraiChannelAuth).repairAccountNicknames(pool).then((repaired) => {
        if (repaired.length > 0) {
          ctx.logger.info(
            '[channel-pack] 已修正 ' + repaired.length + ' 个 LobsterAI 账号的显示名（手机号改为只露末 2 位）：' + repaired.join(', '),
          )
        }
      }).catch((error: unknown) => {
        ctx.logger.warn('[channel-pack] 修正 LobsterAI 账号显示名失败：' + String(error))
      })
    },
    // 定时续期：LobsterAI 的批量续期在 Auth 自己身上。
    refreshAll: async (target) => {
      await auth?.refreshAll(target)
    },
  }
}
