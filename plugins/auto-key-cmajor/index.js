/**
 * 自动转 C 大调 —— 主进程入口
 *
 * 工作方式
 * --------
 * 插件跑在 vm 沙箱里，没有 fs / child_process，读不了也写不了 MIDI 文件。
 * 所以分工是：
 *   渲染层（ui.js）  用 fuBridge.pickFile() 让用户选文件，拿到真实路径
 *   主进程（本文件）  只做参数编排，实际计算交给自带的 key_tools.py
 *   Python 脚本       跑在引擎 Python 环境里，用 pretty_midi 读写 MIDI
 *
 * 为什么自带脚本而不是改引擎：引擎目录属于应用本体，插件不该往里加文件。
 * engine.run 的 script 参数支持绝对路径，所以直接指向插件目录即可。
 */

const path = require('path')

// 宿主把 __dirname 传给了插件模块，可以据此定位自带的 Python 脚本
const SCRIPT = path.join(__dirname, 'key_tools.py')

/** 插件支持的命令行接口 */
const COMMANDS = {
  /** 读取插件自带脚本的绝对路径（渲染层用它做自检） */
  scriptPath: async () => ({ path: SCRIPT }),

  /** 识别调性 */
  analyze: (ctx, payload) => run(ctx, ['analyze', requirePath(payload, 'input')]),

  /**
   * 移调到目标调（默认 C 大调）
   * payload: { input, output, target='C', mode='diatonic'|'pitch' }
   */
  transpose: (ctx, payload) => {
    const input = requirePath(payload, 'input')
    const output = payload && payload.output ? String(payload.output) : defaultOutput(input)
    const target = normalizeTarget((payload && payload.target) || 'C')
    const mode = (payload && payload.mode) === 'pitch' ? 'pitch' : 'diatonic'
    return run(ctx, ['transpose', input, output, '--mode', mode, '--target', target])
  },

  /** 一键转 C 大调：识别 + 移调一次完成，输出完整报告 */
  toCMajor: (ctx, payload) => {
    const input = requirePath(payload, 'input')
    const output = (payload && payload.output) ? String(payload.output) : defaultOutput(input, 'C')
    return run(ctx, ['transpose', input, output, '--mode', 'diatonic', '--target', 'C'])
  },
}

/** 调用引擎跑 Python，把结果整理成命令返回值 */
async function run(ctx, args) {
  if (!ctx.engine) {
    return { ok: false, error: '当前插件权限下无法调用引擎（缺少 engine 能力）' }
  }
  const started = Date.now()
  const r = await ctx.engine.run(args, {
    script: SCRIPT,
    timeoutMs: 5 * 60 * 1000,   // 分析/移调都是秒级操作，5 分钟足够兜底
  })

  if (r.code !== 0 && !r.result) {
    const detail = (r.err || r.out || '').trim().split('\n').slice(-3).join(' ')
    return { ok: false, error: detail || `引擎退出码 ${r.code}` }
  }
  if (!r.result) {
    return { ok: false, error: '脚本没有返回结果（可能缺少 pretty_midi 依赖）' }
  }
  return { ...r.result, elapsedMs: Date.now() - started }
}

function requirePath(payload, key) {
  const p = payload && payload[key]
  if (!p || typeof p !== 'string') {
    const e = new Error(`缺少参数 ${key}`)
    e.userFacing = true
    throw e
  }
  return p
}

/**
 * 目标调名归一化：容忍用户输入 'c' / 'C大调' / 'bb' 这类写法。
 * 只保留字母与 #/b/- 后缀，避免把奇怪字符串直接喂给脚本。
 */
function normalizeTarget(raw) {
  const s = String(raw || '').trim()
  const m = s.match(/^([A-Ga-g])\s*(#|b|-)?\s*(m|min|major|M| maj)?$/)
  if (!m) return 'C'
  let name = m[1].toUpperCase() + (m[2] || '')
  if (m[2] === '-') name += 'b'
  const mode = (m[3] || '').toLowerCase()
  if (mode === 'm' || mode === 'min') return name + 'm'
  return name
}

/** 默认输出路径：原文件同级，加 _C 后缀，绝不覆盖原文件 */
function defaultOutput(input, suffix) {
  const dir = path.dirname(input)
  const ext = path.extname(input) || '.mid'
  const base = path.basename(input, ext)
  const tag = suffix === 'C' ? '_C' : '_' + String(suffix || 'out').replace(/[^\w-]/g, '')
  return path.join(dir, base + tag + ext)
}

module.exports = {
  activate(ctx) {
    for (const [name, fn] of Object.entries(COMMANDS)) {
      ctx.commands.register(name, async (payload) => {
        try {
          return await fn(ctx, payload)
        } catch (e) {
          const msg = e && e.userFacing ? e.message : (e && e.message) || String(e)
          ctx.log('命令失败 ' + name + '：' + msg)
          return { ok: false, error: msg }
        }
      })
    }

    ctx.log('自动转 C 大调已就绪（命令：' + Object.keys(COMMANDS).join('、') + '）')
    ctx.ui.broadcast('ready', { commands: Object.keys(COMMANDS) })
  },

  deactivate() {
    // 无需清理：每次调用都是独立的 Python 子进程
  },
}

// 便于在插件外复用归一化逻辑（也方便测试）
module.exports._normalizeTarget = normalizeTarget
module.exports._defaultOutput = defaultOutput
