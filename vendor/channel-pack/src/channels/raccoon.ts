/**
 * Raccoon Work（商汤小浣熊）渠道的装配描述。
 *
 * 本文件是 `index.ts` 中原 Raccoon 装配块的**原样搬运**，不是重写：options
 * 内容（凭据解析、续期、账号轮换、远端目录、图片桥接）逐字保留，只把「谁调用
 * `registerRaccoonLlm`」从内联语句改成注册表的一个条目。
 *
 * 迁移动机见 `channel-registry.ts` 的模块头；业务逻辑见各 `raccoon-*.ts`。
 *
 * 登录与 Loomy 同型（**本地页承载**的微信扫码 + 短信双路径），但**有** refresh
 * 端点（凭据可静默续期），且客户端可能未安装。
 *
 * ⚠️ **不依赖客户端**：官方桌面端靠 `office-raccoon://auth/callback` 自定义
 * 协议回调，本插件（宿主侧 Node 进程）收不到；故改为「宿主本地生成 code +
 * 自行轮询」，完全绕开该回调。凭据存插件自有的 ctx.credentials，不读客户端
 * 任何文件。
 *
 * @module channels/raccoon
 */
import type { Context } from '@deepseek-ai/cordis'
import { RaccoonAuth } from '../raccoon-auth.js'
import { registerRaccoonLlm } from '../raccoon-adapter.js'
import { RACCOON } from '../raccoon-product.js'
import type { RaccoonCredential } from '../raccoon.js'
import type { RaccoonRemoteModel } from '../raccoon-auth.js'
import type { AccountPool } from '../account-pool.js'
import type { ChannelAuthInstance, ChannelHost, ChannelSpec } from '../channel-registry.js'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { reportLedgerAccount } from '../token-ledger.js'

/**
 * RaccoonAuth 在注册表最小接口之外的额外能力。
 *
 * `index.ts` 在装配之后还要用它们（`repairAccountNicknames` 与
 * `refreshAll`），所以 auth 实例必须原样保留，不能被最小接口截断。
 */
export interface RaccoonChannelAuth extends ChannelAuthInstance {
  refreshAccountCredential(ref: string, pool: AccountPool, accountId: string): Promise<void>
  refresh(): Promise<void>
  fetchModels(pool?: AccountPool): Promise<RaccoonRemoteModel[]>
  refreshAll(pool: AccountPool): Promise<void>
  repairAccountNicknames(pool: AccountPool, build: (row: unknown) => string): Promise<unknown>
}

/** 装配期需要、但不属于 `ChannelHost` 的依赖（账号池由 index.ts 持有）。 */
export interface RaccoonChannelDeps {
  readonly pool: AccountPool
}

/** 构造 raccoon 的注册表条目。 */
export function createRaccoonChannel(deps: RaccoonChannelDeps): ChannelSpec {
  const { pool } = deps
  return {
    id: RACCOON.id,
    namespace: 'llm-raccoon',
    createAuth: ctx => new RaccoonAuth(ctx) as unknown as ChannelAuthInstance,
    registerLlm: (ctx: Context, host: ChannelHost, auth) => {
      const raccoon = auth as unknown as RaccoonChannelAuth
      // ⚠️ raccoon 尤其需要请求版本：该网关按**请求体字节**设限
      // （实测 `HTTP_413: request body exceeds 10MB`，两张大截图就占掉大半配额）。
      return registerRaccoonLlm(ctx, {
        credentialRef: credentialRef(RACCOON.defaultCredentialRef),
        resolveCredential: async (modelId?: string) => {
          // 只从 raccoon 自己的账号池取账号，回退到自己的单凭据 ref，
          // 保证不会串用其它 provider 的凭据。
          const available = await pool.getAvailableAccount(RACCOON.id, modelId ?? '')
          // 联合（历史遗留），与 `RaccoonCredential` 无充分重叠，故经 unknown 转换。
          // 运行时安全性由 provider 过滤保证：查询用 `RACCOON.id`，取到的必是
          // raccoon 凭据。
          if (available) {
            // Token 账本（第 2 期）：回报「本笔请求解析出的账号」。
            reportLedgerAccount(RACCOON.id, available.entry.id)
            return available.credential as unknown as RaccoonCredential
          }
          host.throwIfAllAccountsRateLimited(RACCOON, modelId)
          const resolved = await ctx.credentials.resolve(credentialRef(RACCOON.defaultCredentialRef))
          if (!resolved) return undefined
          try {
            return JSON.parse(resolved.value) as RaccoonCredential
          } catch {
            return undefined
          }
        },
        refresh: async (accountId?: string) => {
          const entry = accountId === undefined ? undefined
            : pool.listAccountsByProvider(RACCOON.id).find(account => account.id === accountId)
          if (accountId !== undefined && entry === undefined) throw new Error('raccoon: account no longer exists')
          if (entry) await raccoon.refreshAccountCredential(entry.credentialRef, pool, entry.id)
          else await raccoon.refresh()
          const resolved = await ctx.credentials.resolve(credentialRef(entry?.credentialRef ?? RACCOON.defaultCredentialRef))
          if (!resolved) throw new Error('raccoon: credential no longer exists')
          return JSON.parse(resolved.value) as RaccoonCredential
        },
        nextAccount: async (modelId, tried) => {
          const next = await pool.getAvailableAccount(RACCOON.id, modelId, tried)
          if (!next) return undefined
          reportLedgerAccount(RACCOON.id, next.entry.id)
          return { accountId: next.entry.id, credential: next.credential as unknown as RaccoonCredential }
        },
        // 远端模型目录：委托给 RaccoonAuth.fetchModels（它负责 Bearer 头与
        // visible 过滤 + raccoonDisplayName 生成含倍率的展示名）。
        // 失败时返回空数组，由适配器回退兜底表。
        fetchRemoteModels: () => raccoon.fetchModels(pool),
        // 图片字节桥接：按模型能力判定（远端 tags 含 vision）。
        readImage: host.readImage,
        readImageRequest: host.readImageRequest,
        accountPool: pool,
        product: RACCOON,
      })
    },
  }
}