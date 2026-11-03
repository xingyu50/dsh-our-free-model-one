// Minimal host contracts for the generated channel pack's offline mount test.
// Provider implementation, pool persistence and RPC handlers remain real.
export class Service {
  constructor(ctx, name) { this.ctx = ctx; ctx.provide(name, this) }
}
export class LlmAdapter {}
/**
 * `constructor(message, code, options)` —— 与真实宿主 `@deepseek-ai/dsh-llm` 的
 * `LlmError` 同序同名（`node_modules/@deepseek-ai/dsh-llm/lib/index.js` 的
 * `HarnessError`）。生产侧 146 处调用全是「消息在前、码在后」，桩若反着写，
 * 每个经过它的「要不要换号」判据都会把 `code` 读成消息串而判反 —— 而且不会红。
 * `status` / `providerRetryAfterMs` 挂在 `failure` 上，不是顶层属性（见
 * `src/openai-gateway/stream.ts` 的注释）。
 */
export class LlmError extends Error {
  constructor(message, code, options) {
    super(message, options)
    this.code = code
    this.name = 'LlmError'
    this.failure = Object.freeze({
      message,
      code,
      ...(options?.status === undefined ? {} : { status: options.status }),
      ...(options?.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: options.providerRetryAfterMs }),
    })
  }
}
/** Cordis `Context` 的最小替身：`account-pool.ts` 只用它 `provide()` / `get()`。 */
export class Context {
  constructor() { this.store = new Map() }
  provide(name, value) { this.store.set(name, value); return value }
  get(name) { return this.store.get(name) }
}
export const credentialRef = value => value
export const ReasoningEffortId = value => value
export const ToolCallId = value => value
export const createUserMessage = value => value
export const attributionHeaders = () => ({})
export const CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED'
export const EMPTY_RESPONSE_CODE = 'EMPTY_RESPONSE'
export const QUOTA_EXCEEDED_CODE = 'QUOTA_EXCEEDED'
export const isContextWindowExceededError = error => error?.code === CONTEXT_WINDOW_EXCEEDED_CODE
export const isQuotaExceededError = error => error?.code === QUOTA_EXCEEDED_CODE
const schema = new Proxy(() => schema, { get: () => schema })
export default schema
