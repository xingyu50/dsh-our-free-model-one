/**
 * 渠道注册表：一个渠道从「存在」到「可用」的登记只在这里发生一次。
 *
 * ## 为什么存在
 *
 * 这份表守的是三条**已经发生过**的故障，不是理论风险：
 *
 * 1. `index.ts` 曾有两份逐字重复的 `stop()` 清单（实测 :1709-1721 与
 *    :1734-1746，各 11 行），只能靠人工保持同步。zcode 的浏览器清理
 *    （`zcodeAdapter.stop()`）就是因为漏写而被单独补进去过一次。
 * 2. `channel-pack-rpc.ts` 用 15 个位置形参传递 auth 实例，该文件自己的注释
 *    记录着「历史上已因少传/插队错位复发 6 次」。
 * 3. 新增一个渠道要同时改 `index.ts` 的装配块、settings namespace 列表、
 *    `modelAdapters` 表、两份 stop 清单和 RPC 形参表 —— 五处，无编译器检查。
 *
 * ## 设计约束
 *
 * 注册表**只接管装配与生命周期**，不接管渠道实现。每个渠道的 options 内容
 * （凭据解析、续期、图片桥接、远端目录）原封不动留在自己的 `channels/<id>.ts`
 * 里，通过闭包捕获所需依赖。
 *
 * ## 为什么依赖从 host 注入而不是 import
 *
 * `makeReadImage` / `makeReadImageRequest` / `throwIfAllAccountsRateLimited`
 * 都定义在 `index.ts`。若 `channels/<id>.ts` 直接 import 它们，会形成
 * `index.ts → channel-registry → channels/<id> → index.ts` 的环。因此这几个
 * 由 `index.ts` 打包成 `ChannelHost` 注入 —— 同时这也让渠道 spec 变成纯函数，
 * 测试可以直接伪造 host。
 *
 * ## 为什么 createAuth 与 registerLlm 分成两步
 *
 * 调用方（`index.ts`）在装配之后、生命周期之前还要用 auth 实例本身：
 * raccoon 的 `repairAccountNicknames` 与 `refreshAll` 都在那个窗口里。
 * 合并成一个 `mount()` 会把实例藏起来。
 *
 * @module channel-registry
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ImageRequestTarget } from './image-budget.js'

/** 适配器实例暴露给装配层的最小接口（供 `modelAdapters` 表使用）。 */
export interface ChannelAdapterInstance {
  listAllModels(): readonly { id: string; name: string }[]
}

/**
 * Auth 服务实例暴露给生命周期的最小接口。
 *
 * ⚠️ `stop` 是**可选**的，而且必须保持可选。实测 13 个 Auth 类里只有 8 个
 * 自己定义了 `stop()`（buddy/cline/lobsterai/loomy/qoder/trae/zcode/codearts）；
 * gemini、minimax、raccoon、opencode 四个没有，基类 `@deepseek-ai/cordis` 的
 * `Service` 也不提供 —— 它们没有任何需要显式回收的资源。
 *
 * 早先版本把它写成必需，结果 `stopChannels` 一调用就抛
 * `TypeError: auth.stop is not a function`（channel-source 套件抓到的真实回归）。
 */
export interface ChannelAuthInstance {
  stop?(): void
}

/** 图片附件桥接：读原始字节。与 `makeReadImage(ctx)` 的返回值同型。 */
export type ReadImageBridge = (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string }>

/** 图片请求版本桥接；`undefined` 表示「该发原图」。 */
export type ReadImageRequestBridge = (
  attachment: unknown,
  target: ImageRequestTarget,
) => Promise<{ data: Uint8Array; mediaType: string } | undefined>

/**
 * 装配期宿主依赖。
 *
 * 刻意只放**渠道 spec 真正需要**的几个能力，不放整个 ctx：这样 spec 与
 * index.ts 之间的耦合面可以一眼看完，且测试不必伪造一整个宿主。
 */
export interface ChannelHost {
  readonly readImage: ReadImageBridge
  readonly readImageRequest: ReadImageRequestBridge
  /** 所有账号都在限流中时抛出带业务码的错误；否则静默返回。 */
  readonly throwIfAllAccountsRateLimited: (
    product: { id: string; displayName: string },
    modelId?: string,
  ) => void
}

/** 一个渠道的全部装配信息。 */
export interface ChannelSpec {
  /** 渠道 id：账号池 provider、RPC 分派键、日志前缀都用它。 */
  readonly id: string
  /** 老契约的 settings namespace（`llm-<id>`）。 */
  readonly namespace: string
  /** 创建 Auth 服务。 */
  readonly createAuth: (ctx: Context) => ChannelAuthInstance
  /**
   * 注册 LLM 适配器并返回实例。
   *
   * `auth` 作为参数而不是通过 ctx 服务查找：注册表在 createAuth 之后立刻调用
   * 这里，此时服务是否已 `ctx.provide` 取决于各 Auth 的构造时机，查找会是
   * undefined。直接传实例是唯一不依赖时序的写法。
   */
  readonly registerLlm: (
    ctx: Context,
    host: ChannelHost,
    auth: ChannelAuthInstance,
  ) => ChannelAdapterInstance
}

/** 装配一个渠道的结果，供 index.ts 后续使用。 */
export interface ChannelRuntime {
  readonly spec: ChannelSpec
  readonly auth: ChannelAuthInstance
  readonly adapter: ChannelAdapterInstance
}

/**
 * 遍历注册表完成装配。
 *
 * `specs` 由调用方传入而非模块内固定常量：渠道 spec 需要账号池等宿主依赖
 * （`createRaccoonChannel({ pool })`），而这些依赖只有 `index.ts` 持有。
 * 把「有哪些渠道」与「按什么顺序装」分开，前者留在各 `channels/<id>.ts`，
 * 后者就是这一个循环。
 */
export function mountChannels(
  ctx: Context,
  host: ChannelHost,
  specs: readonly ChannelSpec[],
): ChannelRuntime[] {
  return specs.map(spec => {
    const auth = spec.createAuth(ctx)
    const adapter = spec.registerLlm(ctx, host, auth)
    return { spec, auth, adapter }
  })
}

/**
 * 停止所有已装配的渠道。
 *
 * 替换 `index.ts` 原先手工维护的两份 `stop()` 清单。只对**真正实现了
 * `stop()`** 的 Auth 调用 —— 见 {@link ChannelAuthInstance.stop} 为何是可选的。
 * 一个渠道没有清理需求时，「什么都不做」正是正确行为，不该被当成缺陷。
 *
 * 幂等：`index.ts` 里有**两个** `ctx.effect` 都调这里（一个随续期调度器武装，
 * 一个无条件注册），宿主可能两个都执行。不在这里按实例去重，某个 Auth 的
 * `stop()` 一旦不幂等（例如它 close 一个已 close 的 socket），就会在卸载时
 * 抛错并打断后面的清理。去重成本是一个 WeakSet，比重试便宜。
 */
export function stopChannels(runtimes: readonly ChannelRuntime[]): void {
  for (const { auth } of runtimes) {
    if (stopped.has(auth)) continue
    stopped.add(auth)
    auth.stop?.()
  }
}

/** 已停止的 Auth 实例。WeakSet 不阻止 GC，卸载后不会留下引用。 */
const stopped = new WeakSet<object>()