/**
 * 思考档位提示的去重器。
 *
 * 档位无法表达时（模型没有这一族，例如给只声明 `low/high/max` 的
 * `buddy/deepseek-v4.1-flash` 要 `none`），`normalizeReasoningEffort`
 * 会**每一轮**都回调一次。原样逐条打印，启动窗口里就是同一行刷屏
 * （用户报障：每调用一次模型就多一行），真正异常反而被淹没。
 *
 * 故按「模型 + 请求档位 + 实际下发」去重：同一情况只记第一轮。
 * 键的取值域是「模型数 × 档位数」，不会无界增长。
 *
 * 去重的是**重复**，不是事实：第一次仍然照记，否则「选了 Off 却没生效」
 * 这件事事后无从解释（见 `vendor/channel-pack/src/openai-gateway/messages.ts`
 * 的 `ReasoningEffortNotice` 注释）。
 */

/**
 * @param {(message: string) => void} emit - 实际写日志的函数
 * @returns {(model: string, notice: { requested: string, applied?: string }) => void}
 */
export function createEffortNoticeLog(emit) {
  const seen = new Set()
  return (model, notice) => {
    // `applied` 缺省与空串是同一件事（都不下发该参数），不能算两个键。
    const key = `${model}\u0000${notice.requested}\u0000${notice.applied ?? ''}`
    if (seen.has(key)) return
    seen.add(key)
    emit(`${model}：思考档位 ${notice.requested} ${notice.applied ? `映射为 ${notice.applied}` : '使用模型默认'}（同类提示只记一次）`)
  }
}
