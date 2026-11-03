/**
 * Qoder（阿里系 AI IDE）国际版与中国版两个渠道的装配描述。
 *
 * 本文件是 `index.ts` 中原两个 Qoder 装配块的**原样搬运**：options 内容与注释
 * 逐字保留，只把宿主依赖（账号池、图片桥接）改成注册表注入。
 *
 * ⚠️ 两站是**同一套协议实现**的第二个实例（差异全在 `QODER` / `QODER_CN` 配置里：
 * 域名、client_id 与各自一张模型表）。刻意**不复制**任何 `qoder*.ts` 实现文件 ——
 * 协议同源，复制会让同类缺陷（tools 不下发、工具历史丢 tool_calls、错误帧不抛错）
 * 修两遍。
 *
 * @module channels/qoder
 */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { QoderAuth } from '../qoder-auth.js'
import { registerQoderLlm } from '../qoder-adapter.js'
import { QODER, QODER_CN, type QoderProduct } from '../qoder-product.js'
import type { QoderCredential } from '../qoder.js'
import type { AccountPool } from '../account-pool.js'
import type { ChannelAuthInstance, ChannelHost, ChannelSpec } from '../channel-registry.js'
import { reportLedgerAccount } from '../token-ledger.js'

/** Qoder 的 Auth 在注册表最小接口之外的额外能力。 */
export interface QoderChannelAuth extends ChannelAuthInstance {
  refreshAccountCredential(ref: string, pool: AccountPool, accountId: string): Promise<void>
  refresh(): Promise<void>
  refreshAll(pool: AccountPool): Promise<void>
}

/** 装配期需要、但不属于 `ChannelHost` 的依赖。 */
export interface QoderChannelDeps {
  readonly pool: AccountPool
}

/** 国际版（`qoder`）的注册表条目。 */
export function createQoderChannel(deps: QoderChannelDeps): ChannelSpec {
  return makeQoderChannel(deps, {
    product: QODER,
    namespace: 'llm-qoder',
    displayName: 'Qoder',
    rpcAuthKey: 'qoder',
    credentialRefName: QODER.defaultCredentialRef,
    registerComment: '',
  })
}

/** 中国版（`qodercn`）的注册表条目。 */
export function createQoderCnChannel(deps: QoderChannelDeps): ChannelSpec {
  return makeQoderChannel(deps, {
    product: QODER_CN,
    namespace: 'llm-qodercn',
    displayName: 'Qoder (中国版)',
    // ⚠️ 只有这里与渠道 id 不同：渠道 id 是全小写 `qodercn`，而 RPC 的
    // `ChannelPackAuths` 形参沿用驼峰 `qoderCn`（历史命名）。
    rpcAuthKey: 'qoderCn',
    credentialRefName: QODER_CN.defaultCredentialRef,
    registerComment: '',
  })
}

interface QoderChannelOptions {
  readonly product: QoderProduct
  readonly namespace: string
  /** RPC `auths` 表里的键；缺省等于渠道 id。 */
  readonly rpcAuthKey?: string
  readonly displayName: string
  readonly credentialRefName: string
  readonly registerComment: string
}

function makeQoderChannel(deps: QoderChannelDeps, options: QoderChannelOptions): ChannelSpec {
  const { pool } = deps
  const { product } = options
  let authContext: Context = undefined as unknown as Context
  let auth: QoderAuth | undefined
  /**
   * 「本次实际使用的账号 id」跟踪（两个站各持一份，互不影响）。
   *
   * ## 为什么需要它
   *
   * 额度受限时要标记**当前账号**（见 `QoderAdapter.switchAccountOnQuota`）。
   * 但「当前账号」不能靠「再问一次账号池的默认账号」得到 —— 池的选号是
   * `getAvailableAccount()` 的即时决策，与适配器**本次实际拿到**的那份凭据
   * 可能是两个账号（例如池已因限流切走，而适配器手上仍是旧凭据）。
   * 标记落错账号的后果：真正受限的账号没被标记 → 下次又被选中 → 反复撞墙；
   * 无辜账号被标记 → 它当天用不了（虽不致命，但属无谓损失）。
   *
   * 故在 `resolveCredential` 里**记录实际返回的那个账号**，供适配器查询。
   */
  let activeAccountId: string | undefined
  return {
    id: product.id,
    ...(options.rpcAuthKey === undefined ? {} : { rpcAuthKey: options.rpcAuthKey }),
    namespace: options.namespace,
    createAuth: (ctx) => {
      authContext = ctx
      auth = new QoderAuth(ctx,
        product === QODER_CN ? { product: QODER_CN } : undefined,
      )
      return auth as unknown as ChannelAuthInstance
    },
    registerLlm: (ctx: Context, host: ChannelHost) => {
      const qoder = auth as unknown as QoderChannelAuth
      return registerQoderLlm(ctx, {
        credentialRef: credentialRef(options.credentialRefName),
        resolveCredential: async (modelId?: string) => {
          // 只从本产品自己的账号池取账号，回退到自己的单凭据 ref，
          // 保证不会串用其它 provider 的凭据。
          // ⚠️ provider 实参必须是 product.id：写死 'qoder' 会让中国版
          // 查到国际版的账号（两站的池条目按 provider 分区）。
          //
          // ⚠️ `modelId` 透传：Qoder 的额度是「模型 + 账号」维度（见
          // `qoder-adapter.ts` 的 `switchAccountOnQuota`），传空串会让它刚写下的
          // 当日额度标记在下次选号时被忽略。
          const available = await pool.getAvailableAccount(product.id, modelId ?? '')
          if (available) {
            activeAccountId = available.entry.id
            // Token 账本（第 2 期）：回报「本笔请求解析出的账号」。
            reportLedgerAccount(product.id, available.entry.id)
            return available.credential as QoderCredential
          }
          // 回退到单凭据路径：没有账号条目可标记，清空以免标记到过期的 id。
          activeAccountId = undefined
          host.throwIfAllAccountsRateLimited(product, modelId)
          const resolved = await authContext.credentials.resolve(credentialRef(options.credentialRefName))
          if (!resolved) return undefined
          try {
            return JSON.parse(resolved.value) as QoderCredential
          } catch {
            return undefined
          }
        },
        refresh: async () => {
          // 必须刷新**解析凭据时所用的那一个**账号，而不是默认单凭据 ref。
          //
          // 为什么：resolveCredential（上面）优先从账号池取
          // `<ID>_ACCOUNT_XXX` 的凭据，而 `qoder.refresh()` 读写的是
          // `<ID>_ACCESS_TOKEN`。两者错配的后果是 —— 适配器检测到池凭据
          // 过期 → 调 refresh → 成功回写到**另一个** ref → 再 resolve 仍取到
          // 那份未更新的过期凭据 → 带着过期 token 发请求 → 401。
          // 用户看到的是「刚在 Channel Pack 登录好，却一直认证失败」，
          // 而日志里续期全是成功的，极难排查。
          const available = await pool.getAvailableAccount(product.id, '')
          if (available) await qoder.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id)
          else await qoder.refresh()
        },
        readImage: host.readImage,
        // 图片请求版本（缩放）桥接：issue !IKITT9。实测 15 张原图（≈57 MiB）
        // 直接 `TRANSPORT: fetch failed`，撞的是请求体体积。
        // ⚠️ 两站**共用同一个 QoderAdapter 类**，故两边都接缩放
        //（只接一边会让中国版的截图照样撞 57 MiB）。
        readImageRequest: host.readImageRequest,
        accountPool: pool,
        product,
        // 额度受限时标记「本次实际使用的账号」（理由见 activeAccountId 注释）。
        currentAccountId: () => activeAccountId,
      })
    },
    // 定时续期：必须刷池内账号（`<ID>_ACCESS_TOKEN` 从未被写入过）。
    refreshAll: async (target) => {
      await auth?.refreshAll(target)
    },
  }
}
