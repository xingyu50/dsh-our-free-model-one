/**
 * CodeArts（华为云 CodeArts）渠道的装配描述。
 *
 * 本文件是 `index.ts` 中原 CodeArts 装配块的**原样搬运**：options 内容与注释
 * 逐字保留，只把宿主依赖（账号池、图片桥接、全限流报错）改成注册表注入。
 *
 * 迁移动机见 `channel-registry.ts` 的模块头；协议实现见 `llm-adapter.ts` 与
 * `codearts-credits.ts`。
 *
 * ⚠️ **CodeArts 不注册任何斜杠命令**（`codearts-login` / `codearts-status` /
 * `codearts-refresh` 三个已删除）：登录、状态与续期统一在 Channel Pack 设置页完成。
 *
 * @module channels/codearts
 */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { CODEARTS_CREDENTIAL_REF, CodeArtsAuth } from '../service.js'
import { registerCodeArtsLlm, PROVIDER } from '../llm-adapter.js'
import type { AccountPool } from '../account-pool.js'
import type { ChannelAuthInstance, ChannelHost, ChannelSpec } from '../channel-registry.js'
import type { CodeArtsCredential } from '../types.js'

/** CodeArts 的 Auth 在注册表最小接口之外的额外能力（续期与目录）。 */
export interface CodeArtsChannelAuth extends ChannelAuthInstance {
  refreshAccountCredential(ref: string, pool: AccountPool, accountId: string): Promise<void>
  refreshModels(pool: AccountPool): Promise<{ id: string; name: string }[]>
  refreshAll(pool: AccountPool): Promise<void>
}

/** 装配期需要、但不属于 `ChannelHost` 的依赖。 */
export interface CodeArtsChannelDeps {
  readonly pool: AccountPool
}

/** 构造 CodeArts 的注册表条目。 */
export function createCodeArtsChannel(deps: CodeArtsChannelDeps): ChannelSpec {
  const { pool } = deps
  // auth 实例在 createAuth 里产生、被 registerLlm 与 refreshAll 两处复用 ——
  // 与 `channels/raccoon.ts` 同一写法：不重复 new，也不靠 ctx 服务查找。
  let auth: CodeArtsAuth | undefined
  return {
    id: PROVIDER,
    namespace: 'llm-codearts',
    createAuth: (ctx) => {
      auth = new CodeArtsAuth(ctx)
      return auth as unknown as ChannelAuthInstance
    },
    registerLlm: (ctx: Context, host: ChannelHost, instance) => {
      const codearts = instance as unknown as CodeArtsChannelAuth
      return registerCodeArtsLlm(ctx, {
        credentialRef: credentialRef(CODEARTS_CREDENTIAL_REF),
        resolveCredential: async () => {
          // CodeArts **只认账号池**，与其余五个 provider 一致。
          //
          // ⚠️ 早期它额外支持「单凭据模式」（`CODEARTS_ACCESS_TOKEN`）：登录后把凭据
          // 写到那个固定 ref，适配器在账号池取不到时回退去读它。该模式**已移除** ——
          // 登录入口只有 Channel Pack 设置页，凭据一律写入 `CODEARTS_ACCOUNT_XXX`，
          // 固定的 `CODEARTS_ACCESS_TOKEN` 不会再被写入或读取。
          //
          // 这里仍保留 `credentialRef` 选项，仅为满足适配器契约与报错文案
          // （其余 provider 同样传各自的默认 ref，但都不再作为回退来源）。
          const available = await pool.getAvailableAccount(PROVIDER, '')
          return available?.credential as CodeArtsCredential | undefined
        },
        // 续期按**账号池里的具体账号**走：`refreshAccountCredential` 读写的是
        // `CODEARTS_ACCOUNT_XXX`，而旧的 `service.refresh()` 读写的是已废弃的
        // 单凭据 ref —— 那会刷到另一个（不存在的）凭据上。
        refresh: async () => {
          const available = await pool.getAvailableAccount(PROVIDER, '')
          if (available) await codearts.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id)
        },
        fetchRemoteModels: () => codearts.refreshModels(pool),
        accountPool: pool,
      })
    },
    // 定时续期：CodeArts 的批量续期在 Auth 自己身上。
    refreshAll: async (target) => {
      await auth?.refreshAll(target)
    },
  }
}
