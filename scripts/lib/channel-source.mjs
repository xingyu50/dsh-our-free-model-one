/**
 * 渠道源码在测试里的唯一装载入口。
 *
 * vendor/channel-pack/src 用 TypeScript 写，源码里还留着构建期才会解析的 .js 相对导入
 * 后缀；@deepseek-ai/* 是宿主提供的运行时契约，离线测试不能连真宿主。这两件事此前由 11
 * 个套件各自手写一遍，且分成三套互不兼容的转译口径（ts.transpileModule、
 * stripTypeScriptTypes、--experimental-transform-types 自我重启），其中两处还各写了一次
 * spawnSync 重跑自身。口径不一致的代价不是风格问题：strip-only 模式在 account-pool.ts 的
 * 'constructor(private readonly ctx)' 参数属性上直接报错，于是两个套件被迫整进程重启才能跑。
 *
 * 这里把它们收成两步：先 installChannelSource() 装钩子，再用 importChannelSource() 按
 * 文件名装载。装载口径只有一条：stripTypeScriptTypes({ mode: 'transform' }) —— 唯一能
 * 处理参数属性的模式。因此「测试里跑的源码」与「构建出来跑在生产里的源码」共用同一条
 * 转译规则，不再有「这个套件用 tsc、那个套件用 strip」的分叉。
 *
 * ⚠️ passthrough 必须按 specifier 白名单列，而不是靠加载顺序：实测 registerHooks 对
 * **已缓存**的模块仍会跑 resolve 钩子，所以「我先 import 了真宿主，后面的钩子就拦不到
 * 它」这个假设是错的。
 */
import fs from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'

/** vendor/channel-pack/src 的 URL；.js → .ts 改写与转译都只在这一棵树下生效。 */
export const channelSourceRoot = new URL('../../vendor/channel-pack/src/', import.meta.url).href

const kernelUrl = new URL('./channel-pack-kernel.mjs', import.meta.url).href

/**
 * 装上「渠道源码」这一层的解析与转译钩子。
 *
 * @param {object} [options]
 * @param {boolean} [options.enabled] false 时什么都不装（套件的非源码路径用）。
 * @param {string[]} [options.passthrough] 这些 specifier 交给真正的解析器 —— 套件需要真宿主
 *   的某个具体实现（BlockAssembler、invariant、真 Context）时列出它们。
 * @param {Record<string, string>} [options.aliases] specifier → URL 的精确顶替（undici、自造
 *   的 @deepseek-ai/dsh-llm 替身等）。先于 passthrough 判断。
 * @param {Record<string, string>} [options.appendExports] 文件名 → 追加到该文件末尾的源码
 *   （给包内可见、套件却要直接调用的函数开一个出口）。
 * @returns {{ deregister: () => void }}
 */
export function installChannelSource({ enabled = true, passthrough = [], aliases = {}, appendExports = {} } = {}) {
  if (!enabled) return { deregister() {} }
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      if (Object.hasOwn(aliases, specifier)) return { url: aliases[specifier], shortCircuit: true }
      if (passthrough.includes(specifier)) return nextResolve(specifier, context)
      if (specifier.startsWith('@deepseek-ai/')) return { url: kernelUrl, shortCircuit: true }
      // 源码按构建期的 .js 后缀写相对导入；只有渠道包内部这一棵树下才改写。
      if (context.parentURL?.startsWith(channelSourceRoot) && specifier.endsWith('.js')) {
        const url = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href
        if (fs.existsSync(fileURLToPath(url))) return { url, shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
    load(url, context, nextLoad) {
      if (url.startsWith(channelSourceRoot) && url.endsWith('.ts')) {
        let source = fs.readFileSync(fileURLToPath(url), 'utf8')
        const name = url.slice(channelSourceRoot.length)
        if (Object.hasOwn(appendExports, name)) source += '\n' + appendExports[name] + '\n'
        return { format: 'module', shortCircuit: true, source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }) }
      }
      return nextLoad(url, context)
    },
  })
}

/**
 * 按文件名装载渠道源码，例如 importChannelSource('auto-checkin.ts')。
 * @param {string} name 相对 vendor/channel-pack/src 的路径。
 */
export function importChannelSource(name) {
  return import(new URL(name, channelSourceRoot).href)
}
