/**
 * 自动转 C 大调 —— 渲染层
 *
 * 这个脚本被注入应用页面，可以直接用 window.fuBridge。
 * 之所以需要渲染层：插件沙箱里没有 fs，askFile 得由应用来弹框并回传真实路径。
 *
 * 事件协议（与主进程 index.js 对应）：
 *   fuplugin:auto-key-cmajor:ready   插件已激活
 *   fuplugin:auto-key-cmajor:log     主进程日志
 *   fuplugin:auto-key-cmajor:toast   主进程发的提示
 */

(function () {
  'use strict'

  const PLUGIN_ID = 'auto-key-cmajor'
  const EV = (n) => `fuplugin:${PLUGIN_ID}:${n}`

  const bridge = window.fuBridge
  if (!bridge || !bridge.plugins) {
    console.warn('[auto-key-cmajor] fuBridge.plugins 不可用，插件界面无法工作')
    return
  }

  // ---------------------------------------------------------------- 样式
  const STYLE_ID = 'akc-style'
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = `
      .akc-root{font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:var(--ink,#0c0d10)}
      .akc-drop{border:1.5px dashed #d6dae0;border-radius:12px;padding:22px 16px;text-align:center;cursor:pointer;background:#fafbfc;transition:all .18s}
      .akc-drop:hover{border-color:#4f94e0;background:rgba(79,148,224,.07)}
      .akc-drop.has{border-style:solid;text-align:left;padding:14px 16px}
      .akc-main{font-weight:600;font-size:14px}
      .akc-sub{color:#8a919c;font-size:12px;margin-top:3px}
      .akc-key{display:flex;align-items:center;gap:14px;margin:14px 0;padding:13px 15px;border-radius:10px;background:#f6f8fa}
      .akc-keybadge{font-size:22px;font-weight:800;letter-spacing:-.02em;min-width:74px;text-align:center}
      .akc-conf{flex:1}
      .akc-meter{height:4px;border-radius:2px;background:#e3e7ec;overflow:hidden;margin-top:6px}
      .akc-meter i{display:block;height:100%;background:#4f94e0;transition:width .3s}
      .akc-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:12px 0}
      .akc-lbl{font-size:12px;color:#767d88;margin-right:2px}
      .akc-chip{border:1px solid #dfe3e8;background:#fff;border-radius:999px;padding:5px 12px;font-size:12px;font-weight:600;cursor:pointer;transition:all .15s}
      .akc-chip:hover{border-color:#8a919c}
      .akc-chip.on{background:#0c0d10;border-color:#0c0d10;color:#fff}
      .akc-btn{border:none;border-radius:999px;padding:0 18px;height:36px;font-size:13.5px;font-weight:600;cursor:pointer;background:#4f94e0;color:#fff;transition:all .16s}
      .akc-btn:hover:not(:disabled){background:#3d7cc4;transform:translateY(-1px)}
      .akc-btn:disabled{opacity:.5;cursor:not-allowed}
      .akc-btn.ghost{background:#fff;color:#454c56;border:1px solid #dfe3e8}
      .akc-btn.ghost:hover{background:#f4f6f8}
      .akc-log{margin-top:12px;max-height:150px;overflow:auto;font-family:ui-monospace,Consolas,monospace;font-size:11.5px;color:#767d88;background:#fafbfc;border-radius:8px;padding:9px 11px;white-space:pre-wrap}
      .akc-log b{color:#0c0d10}
      .akc-err{color:#c0392b}
      .akc-note{font-size:11.5px;color:#8a919c;margin-top:10px;line-height:1.55}
      .akc-spin{display:inline-block;width:12px;height:12px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:akcsp .7s linear infinite;vertical-align:-2px;margin-right:6px}
      @keyframes akcsp{to{transform:rotate(360deg)}}
    `
    document.head.appendChild(style)
  }

  // ---------------------------------------------------------------- 状态
  const state = {
    file: null,        // { path, name }
    analysis: null,    // 识别结果
    busy: false,
    logEl: null,
  }

  const TARGETS = [
    { key: 'C', label: 'C 大调' },
    { key: 'Am', label: 'A 小调' },
    { key: 'G', label: 'G 大调' },
    { key: 'F', label: 'F 大调' },
    { key: 'D', label: 'D 大调' },
    { key: 'Bb', label: 'Bb 大调' },
    { key: 'Em', label: 'E 小调' },
    { key: 'Dm', label: 'D 小调' },
  ]
  let target = 'C'

  // ---------------------------------------------------------------- 工具
  const el = (tag, cls, txt) => {
    const n = document.createElement(tag)
    if (cls) n.className = cls
    if (txt != null) n.textContent = txt
    return n
  }

  function log(msg, isErr) {
    if (!state.logEl) return
    const line = el('div')
    if (isErr) line.className = 'akc-err'
    const t = el('b', null, new Date().toLocaleTimeString('zh-CN', { hour12: false }))
    t.style.marginRight = '6px'
    line.appendChild(t)
    line.appendChild(document.createTextNode(msg))
    state.logEl.appendChild(line)
    state.logEl.scrollTop = state.logEl.scrollHeight
  }

  async function pickFile() {
    const p = await bridge.pickFile({
      filters: [{ name: 'MIDI 文件', extensions: ['mid', 'midi', 'MID', 'MIDI'] }],
    })
    if (!p) return
    // 只取路径，不消费文件 —— 真正的读取由引擎侧的 Python 完成
    const name = String(p).split(/[\\/]/).pop()
    state.file = { path: p, name }
    state.analysis = null
    render()
    log('已选择：' + name)
    await analyze()
  }

  async function invoke(cmd, payload) {
    const r = await bridge.plugins.invoke(PLUGIN_ID, cmd, payload)
    return r || { ok: false, error: '插件没有返回结果' }
  }

  /** 强制复检：转调后调用。绕开 busy 早退，否则刚设的 busy=true 会让它直接返回。 */
  async function reanalyze() {
    state.busy = false
    await analyze()
  }

  async function analyze() {
    if (!state.file || state.busy) return
    setBusy(true)
    log('正在识别调性…')
    try {
      const r = await invoke('analyze', { input: state.file.path })
      if (r.ok === false) throw new Error(r.error || '识别失败')
      state.analysis = r
      const conf = Math.round((r.confidence || 0) * 100)
      log(`识别结果：${r.key}（置信度 ${conf}%，${r.notes} 个音符 / ${r.tracks} 轨）`)
    } catch (e) {
      state.analysis = null
      log('识别失败：' + (e.message || e), true)
    } finally {
      setBusy(false)
      render()
    }
  }

  async function transpose() {
    if (!state.file || state.busy) return
    setBusy(true)
    log('正在转调到 ' + target + '…')
    try {
      // 目标是 C 大调时走专用命令（少一次进程启动，响应更快）
      const cmd = target === 'C' ? 'toCMajor' : 'transpose'
      const r = await invoke(cmd, { input: state.file.path, target })
      if (r.ok === false) throw new Error(r.error || '移调失败')
      const dst = String(r.out || '').split(/[\\/]/).pop()
      log(`完成：${r.sourceKey} → ${r.target || target}，${r.moved}/${r.total} 个音符已移调`)
      log('输出文件：' + dst)
      if (r.clamped > 0) {
        log(`注意：有 ${r.clamped} 个音符因超出 0-127 范围被截断`, true)
      }
      // 转完重新识别一次，让用户直接看到结果
      state.analysis = null
      await reanalyze()
    } catch (e) {
      log('移调失败：' + (e.message || e), true)
    } finally {
      setBusy(false)
      render()
    }
  }

  function setBusy(v) {
    state.busy = v
    const b = document.getElementById('akc-go')
    if (b) {
      b.disabled = v || !state.file
      b.innerHTML = v ? '<span class="akc-spin"></span>处理中…' : '转到 ' + target
    }
  }

  // ---------------------------------------------------------------- 渲染
  function render() {
    const root = document.getElementById('akc-root')
    if (!root) return
    const scroll = state.logEl ? state.logEl.scrollTop : 0
    root.innerHTML = ''

    // 选择文件
    const drop = el('div', 'akc-drop' + (state.file ? ' has' : ''))
    drop.onclick = pickFile
    if (state.file) {
      drop.appendChild(el('div', 'akc-main', state.file.name))
      drop.appendChild(el('div', 'akc-sub', '点击可重新选择'))
    } else {
      drop.appendChild(el('div', 'akc-main', '点击选择 MIDI 文件'))
      drop.appendChild(el('div', 'akc-sub', '支持 .mid / .midi，处理在本地完成'))
    }
    root.appendChild(drop)

    // 识别结果
    if (state.analysis) {
      const a = state.analysis
      const box = el('div', 'akc-key')
      const badge = el('div', 'akc-keybadge', a.key || '?')
      box.appendChild(badge)
      const conf = el('div', 'akc-conf')
      conf.appendChild(el('div', null,
        `置信度 ${Math.round((a.confidence || 0) * 100)}% · ${a.tracks} 轨 · ${a.notes} 音符 · ${a.durationSec}s`))
      if (a.alternatives && a.alternatives.length) {
        conf.appendChild(el('div', 'akc-sub', '其他可能：' + a.alternatives.map((x) => x.key).join('、')))
      }
      const meter = el('div', 'akc-meter')
      const fill = el('i')
      fill.style.width = Math.max(4, Math.min(100, (a.confidence || 0) * 100)) + '%'
      meter.appendChild(fill)
      conf.appendChild(meter)
      box.appendChild(conf)
      root.appendChild(box)
    }

    // 目标调
    const row = el('div', 'akc-row')
    row.appendChild(el('span', 'akc-lbl', '目标调'))
    for (const t of TARGETS) {
      const c = el('button', 'akc-chip' + (target === t.key ? ' on' : ''), t.label)
      c.onclick = () => {
        target = t.key
        render()
      }
      row.appendChild(c)
    }
    root.appendChild(row)

    // 操作
    const actions = el('div', 'akc-row')
    const go = el('button', 'akc-btn', '转到 ' + target)
    go.id = 'akc-go'
    go.disabled = !state.file || state.busy
    if (state.busy) go.innerHTML = '<span class="akc-spin"></span>处理中…'
    go.onclick = transpose
    actions.appendChild(go)

    const re = el('button', 'akc-btn ghost', '重新识别')
    re.disabled = !state.file || state.busy
    re.onclick = analyze
    actions.appendChild(re)
    root.appendChild(actions)

    root.appendChild(el('div', 'akc-note',
      '移调采用自然音级映射而非简单加减半音，因此转 C 大调后音名拼写也是正确的（如 F# 大调转 C 后记为 Gb，不是 F#）。原文件不会被修改，结果写入同目录的新文件。'))

    // 日志
    state.logEl = el('div', 'akc-log')
    root.appendChild(state.logEl)
    state.logEl.scrollTop = scroll
  }

  // ---------------------------------------------------------------- 挂载
  function mount() {
    if (document.getElementById('akc-root')) return
    const host = document.createElement('div')
    host.id = 'akc-root'
    host.className = 'akc-root'
    // 优先挂到插件面板容器；找不到就挂到 body
    const anchor = document.querySelector('[data-plugin-panel], .plugin-panel, #plugin-panel')
    ;(anchor || document.body).appendChild(host)
    render()
    log('就绪。选择一个 MIDI 文件即可自动识别调性。')
  }

  // 监听主进程
  window.addEventListener(EV('ready'), () => { log('主进程已就绪'); render() })
  window.addEventListener(EV('log'), (e) => log((e.detail && e.detail.line) || ''))
  window.addEventListener(EV('toast'), (e) => {
    const d = e.detail || {}
    if (d.text) log(d.text, d.type === 'error')
  })

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount)
  } else {
    mount()
  }
})()
