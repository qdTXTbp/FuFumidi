// ============================================================
// WebGL2 光栅器（可视化重做 · 光栅层 · M2）
//
// 与 canvas2d.js 吃**同一份 Primitive[]**，职责同样只有一个：把图元画出来。
// 为什么要有它：Canvas2D 的渐变/阴影/描边全在 CPU 光栅化，4K 下 100 ms/帧；
// 参考工程（Neothesia=WGPU、Pianola=GLSL、MIDIVisualizer=OpenGL）都是 GPU 路线。
// 这里用一次 instanced draw 覆盖图元，把每帧的 CPU 工作量压到"填一个 Float32Array"。
//
// 形状全部走 SDF（圆角矩形/胶囊/圆环/径向光），线段在 JS 里展成窄四边形，
// 渐变用 4 个采样色在片元里分段线性重建 —— 与 Canvas 的 4 段渐变逐段对应。
// 文字（text）**不在这里画**：留给门面用 Canvas2D 叠在最上层（字形质量更好）。
//
// 布局（每实例 29 个 float，交错）：
//   [0..7] P0..P3 四个角（设备像素，TL/TR/BR/BL）
//   [8..23] 4 个渐变采样色 RGBA（0/⅓/⅔/1）
//   [24..27] shape = (kind, radius|strength, r0, dir)
//   [28] alpha
// packPrims 是**纯函数**：Node 里可以直接断言打包结果，这是 M2 可测性的抓手。
// ============================================================

import { createGLPost } from '../post/glpost.js';

const VS = `#version 300 es
in vec2 aP0; in vec2 aP1; in vec2 aP2; in vec2 aP3;
in vec4 aS0; in vec4 aS1; in vec4 aS2; in vec4 aS3;
in vec4 aShape;
in float aAlpha;
uniform vec2 uRes;
out vec2 vUV; out vec2 vSize;
out vec4 vS0; out vec4 vS1; out vec4 vS2; out vec4 vS3;
out vec4 vShape; out float vAlpha;
void main() {
  // uv 由顶点序号推导（4 顶点三角带），不额外占一个顶点属性
  vec2 uv = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  vec2 p = mix(mix(aP0, aP1, uv.x), mix(aP3, aP2, uv.x), uv.y);
  vec2 c = (p / uRes) * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
  vUV = uv;
  vSize = vec2(length(aP1 - aP0), length(aP3 - aP0));
  vS0 = aS0; vS1 = aS1; vS2 = aS2; vS3 = aS3;
  vShape = aShape; vAlpha = aAlpha;
}`;

const FS = `#version 300 es
precision highp float;
in vec2 vUV; in vec2 vSize;
in vec4 vS0; in vec4 vS1; in vec4 vS2; in vec4 vS3;
in vec4 vShape; in float vAlpha;
uniform vec2 uRes;
out vec4 outColor;

// 4 个采样色 = 原渐变的 0/⅓/⅔/1，分段线性还原（4 段渐变逐段精确）
vec4 grad(float u) {
  float f = clamp(u, 0.0, 1.0) * 3.0;
  float i = min(floor(f), 2.0);
  float t = f - i;
  vec4 a = i < 0.5 ? vS0 : (i < 1.5 ? vS1 : vS2);
  vec4 b = i < 0.5 ? vS1 : (i < 1.5 ? vS2 : vS3);
  return mix(a, b, t);
}

void main() {
  float kind = vShape.x;
  float aa = 0.7;
  vec4 col = vS0;
  float a = vAlpha;
  if (kind < 2.5) {                       // 0 矩形 / 2 胶囊：圆角盒 SDF（覆盖度≈面积，与 canvas 的解析 AA 对齐）
    vec2 hp = vSize * 0.5;
    float r = min(vShape.y, min(hp.x, hp.y));
    vec2 q = abs(vUV * vSize - hp) - (hp - r);
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
    a *= clamp(0.5 - d, 0.0, 1.0);
    col = grad(vShape.w > 0.5 ? vUV.x : vUV.y);
  } else if (kind < 1.5) {                // 1 四边形（透视梯形）
    col = grad(vShape.w > 0.5 ? vUV.x : vUV.y);
  } else if (kind < 3.5) {                // 3 径向光：内半径起算，三档停点与 canvas 一致
    float d = length(vUV - 0.5) * 2.0;
    float u = clamp((d - vShape.z) / max(0.001, 1.0 - vShape.z), 0.0, 1.0);
    float g = u < 0.45 ? mix(0.85, 0.32, u / 0.45) : mix(0.32, 0.0, (u - 0.45) / 0.55);
    a *= g;
  } else if (kind < 4.5) {                // 4 圆环
    float d = length((vUV - 0.5) * vSize);
    float lw = max(0.5, vShape.y);
    a *= clamp(lw * 0.5 + 0.5 - abs(d - vShape.z), 0.0, 1.0);
  } else if (kind < 5.5) {                // 5 光柱：canvas 三层嵌套矩形（0.42/0.71/1.0 宽 × 0.40/0.27/0.14）的解析等价
    float dx = abs(vUV.x - 0.5);
    float g = (dx <= 0.21 ? 0.40 : 0.0) + (dx <= 0.355 ? 0.27 : 0.0) + (dx <= 0.5 ? 0.14 : 0.0);
    a *= g * vUV.y;
  } else if (kind < 6.5) {                // 6 线：沿垂直方向按线宽做 AA（与 canvas stroke 对齐）
    float d = abs(vUV.y - 0.5) * vSize.y;
    float lw = max(0.5, vShape.y);
    a *= clamp(lw * 0.5 + 0.5 - d, 0.0, 1.0);
    col = vS0;
  } else {                                // 7 暗角：shape=(7, strength, cx, cy)
    float R = max(uRes.x, uRes.y) * 0.78;
    vec2 c0 = vec2(vShape.z * uRes.x, vShape.w * uRes.y);
    float d = length(vUV * uRes - c0);
    a *= clamp((d - R * 0.35) / (R * 0.65), 0.0, 1.0) * vShape.y;
    col = vec4(0.0, 0.0, 0.0, 1.0);
  }
  if (a <= 0.0008) discard;
  outColor = vec4(col.rgb, col.a * a);
}`;

export const GL_KINDS = { rect: 0, quad: 1, capsule: 2, glow: 3, ring: 4, beam: 5, line: 6 };
export const GL_STRIDE = 29;

function parseColor(c) {
  const s = String(c == null ? '#ffffff' : c).trim();
  let m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) return [parseInt(m[1].slice(0, 2), 16) / 255, parseInt(m[1].slice(2, 4), 16) / 255, parseInt(m[1].slice(4, 6), 16) / 255, 1];
  m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) { const h = m[1]; return [parseInt(h[0] + h[0], 16) / 255, parseInt(h[1] + h[1], 16) / 255, parseInt(h[2] + h[2], 16) / 255, 1]; }
  m = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (m) {
    const q = m[1].split(',').map((v) => parseFloat(v));
    return [(q[0] || 0) / 255, (q[1] || 0) / 255, (q[2] || 0) / 255, q.length > 3 ? (q[3] == null ? 1 : q[3]) : 1];
  }
  return [1, 1, 1, 1];
}

/** 取填充的 4 个采样色（沿渐变轴 0/⅓/⅔/1），与片元里的分段线形一一对应 */
export function sampleFill(fill) {
  if (typeof fill === 'string' || !fill) { const c = parseColor(fill); return { stops: [c, c, c, c], dir: 0 }; }
  const raw = (fill.stops || []).map(parseColor);
  const st = raw.length ? raw : [[1, 1, 1, 1]];
  const dir = fill.dir === 'h' ? 1 : 0;
  if (st.length === 1) return { stops: [st[0], st[0], st[0], st[0]], dir };
  const out = [];
  for (let j = 0; j < 4; j++) {
    const u = j / 3;
    const f = u * (st.length - 1);
    const i = Math.min(st.length - 2, Math.floor(f));
    const t = f - i;
    const A = st[i], B = st[i + 1];
    out.push([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t, A[3] + (B[3] - A[3]) * t]);
  }
  return { stops: out, dir };
}

const blendOf = (b) => (b === 'lighter' ? 'lighter' : b === 'multiply' ? 'multiply' : 'normal');

/**
 * 打包图元 → 交错实例数据 + 混合模式分段（纯函数，可直接单测）。
 * @param prims 图元数组（已按层/z 排好序）
 * @param pw,ph 画布设备像素尺寸（暗角需要）
 * @param scale CSS→设备像素倍率（含 ssaa）
 * @returns { data, count, runs:[{blend,start,count}] }
 */
export function packPrims(prims, pw, ph, scale) {
  const s = scale || 1;
  const data = new Float32Array(Math.max(1, prims.length) * GL_STRIDE);
  const runs = [];
  let n = 0, cur = null, runStart = 0;
  const put = (P0x, P0y, P1x, P1y, P2x, P2y, P3x, P3y, stops, shape, alpha) => {
    const o = n * GL_STRIDE;
    data[o] = P0x; data[o + 1] = P0y; data[o + 2] = P1x; data[o + 3] = P1y;
    data[o + 4] = P2x; data[o + 5] = P2y; data[o + 6] = P3x; data[o + 7] = P3y;
    for (let i = 0; i < 4; i++) { const c = stops[i]; const b = o + 8 + i * 4; data[b] = c[0]; data[b + 1] = c[1]; data[b + 2] = c[2]; data[b + 3] = c[3]; }
    data[o + 24] = shape[0]; data[o + 25] = shape[1]; data[o + 26] = shape[2]; data[o + 27] = shape[3];
    data[o + 28] = alpha;
    n++;
  };
  for (const p of prims) {
    const a = p.alpha == null ? 1 : p.alpha;
    if (a <= 0.0008) continue;
    const b = blendOf(p.blend);
    if (cur === null) { cur = b; runStart = n; }
    else if (b !== cur) { runs.push({ blend: cur, start: runStart, count: n - runStart }); cur = b; runStart = n; }
    const white = [1, 1, 1, 1];
    if (p.k === 'overlay') {
      if (p.kind !== 'vignette') continue;
      const str = p.strength == null ? 0.55 : p.strength;
      put(0, 0, pw, 0, pw, ph, 0, ph, [[0, 0, 0, 1], [0, 0, 0, 1], [0, 0, 0, 1], [0, 0, 0, 1]], [7, str, p.cx == null ? 0.5 : p.cx, p.cy == null ? 0.46 : p.cy], a);
      continue;
    }
    const K = GL_KINDS[p.k];
    if (K === undefined) continue;            // text 等交给 Canvas2D
    if (K === 6) {                            // line → 窄四边形（canvas 是 stroke）；多出 0.5px 供片元做 AA
      const lw = Math.max(0.5, p.lw || 1) * s, half = lw / 2 + 0.5, hx = (p.x1 - p.x0) * s, hy = (p.y1 - p.y0) * s;
      const len = Math.hypot(hx, hy) || 1, nx = -hy / len * half, ny = hx / len * half;
      const x0 = p.x0 * s, y0 = p.y0 * s, x1 = p.x1 * s, y1 = p.y1 * s;
      const c = parseColor(p.color);
      put(x0 + nx, y0 + ny, x1 + nx, y1 + ny, x1 - nx, y1 - ny, x0 - nx, y0 - ny, [c, c, c, c], [6, lw, 0, 0], a);
      continue;
    }
    if (K === 3) {                            // glow：外半径解析与 canvas2d 完全一致
      const r1 = Math.max(0.1, p.r1 || p.r0 || 1);
      const r0 = Math.max(0, p.r0 || 0);
      if (r0 >= r1 * 0.999) continue;          // canvas 规范：内外半径相等 → 什么都不画
      const c = parseColor(p.color);
      put((p.x - r1) * s, (p.y - r1) * s, (p.x + r1) * s, (p.y - r1) * s, (p.x + r1) * s, (p.y + r1) * s, (p.x - r1) * s, (p.y + r1) * s, [c, c, c, c], [3, 0, r0 / r1, 0], a);
      continue;
    }
    if (K === 4) {                            // ring
      const r = Math.max(0.5, p.r) * s, lw = Math.max(0.5, p.lw || 1) * s, hf = (Math.max(0.5, p.r) + (p.lw || 1) / 2 + 1) * s;
      const c = parseColor(p.color);
      put(p.x * s - hf, p.y * s - hf, p.x * s + hf, p.y * s - hf, p.x * s + hf, p.y * s + hf, p.x * s - hf, p.y * s + hf, [c, c, c, c], [4, lw, r, 0], a);
      continue;
    }
    if (K === 5) {                            // beam：bbox 底边在 y，向上 h
      const c = parseColor(p.color);
      put((p.x - p.w / 2) * s, (p.y - p.h) * s, (p.x + p.w / 2) * s, (p.y - p.h) * s, (p.x + p.w / 2) * s, p.y * s, (p.x - p.w / 2) * s, p.y * s, [c, c, c, c], [5, 0, 0, 0], a);
      continue;
    }
    const F = sampleFill(p.fill);
    const stops = F.stops.length === 4 ? F.stops : [F.stops[0], F.stops[0], F.stops[0], F.stops[0]];
    if (K === 1) {                            // quad
      const q = p.pts;
      put(q[0] * s, q[1] * s, q[2] * s, q[3] * s, q[4] * s, q[5] * s, q[6] * s, q[7] * s, stops, [1, 0, 0, F.dir], a);
      continue;
    }
    const rad = K === 2 ? (p.r == null ? Math.min(p.w, p.h) / 2 : p.r) : (p.r || 0);
    put(p.x * s, p.y * s, (p.x + p.w) * s, p.y * s, (p.x + p.w) * s, (p.y + p.h) * s, p.x * s, (p.y + p.h) * s, stops, [K, rad * s, 0, F.dir], a);
  }
  if (cur !== null && n > runStart) runs.push({ blend: cur, start: runStart, count: n - runStart });
  return { data, count: n, runs };
}

function compileShader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { const log = gl.getShaderInfoLog(s); gl.deleteShader(s); throw new Error('shader: ' + log); }
  return s;
}

function program(gl) {
  const p = gl.createProgram();
  gl.attachShader(p, compileShader(gl, gl.VERTEX_SHADER, VS));
  gl.attachShader(p, compileShader(gl, gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
  return p;
}

let glRaster = null;      // 单例：一次只渲染一张图，尺寸每帧按需 resize
let tried = false;

/** 拿到 WebGL2 光栅器；环境不支持（Node/离线台、驱动黑名单）时返回 null，调用方回退 Canvas2D */
export function getGLRaster() {
  if (tried) return glRaster;
  tried = true;
  try {
    if (typeof document === 'undefined' || !document.createElement) return null;
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true });
    if (!gl) return null;
    const prog = program(gl);
    const L = (n) => gl.getAttribLocation(prog, n);
    const A = {
      P0: L('aP0'), P1: L('aP1'), P2: L('aP2'), P3: L('aP3'),
      S0: L('aS0'), S1: L('aS1'), S2: L('aS2'), S3: L('aS3'), shape: L('aShape'), alpha: L('aAlpha'),
    };
    const uRes = gl.getUniformLocation(prog, 'uRes');
    const postCtx = createGLPost(gl);   // M3：着色器后处理（泛光/调色/色调映射）
    const inst = gl.createBuffer();
    let cap = 0;
    let cw = 0, ch = 0, calls = 0, lastBlend = '';

    function setBlend(b) {
      if (b === lastBlend) return;
      lastBlend = b;
      if (b === 'lighter') gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ONE);
      else if (b === 'multiply') gl.blendFuncSeparate(gl.DST_COLOR, gl.ZERO, gl.DST_ALPHA, gl.ZERO);
      else gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }

    const F = 4;
    const attrs = ['P0', 'P1', 'P2', 'P3', 'S0', 'S1', 'S2', 'S3', 'shape', 'alpha'];
    function bindAttrs(base) {
      const off = base * GL_STRIDE * F;
      const ptr = (l, size, field) => { if (l < 0) return; gl.vertexAttribPointer(l, size, gl.FLOAT, false, GL_STRIDE * F, off + field * F); };
      ptr(A.P0, 2, 0); ptr(A.P1, 2, 2); ptr(A.P2, 2, 4); ptr(A.P3, 2, 6);
      ptr(A.S0, 4, 8); ptr(A.S1, 4, 12); ptr(A.S2, 4, 16); ptr(A.S3, 4, 20);
      ptr(A.shape, 4, 24); ptr(A.alpha, 1, 28);
    }

    function resize(w, h) {
      cw = Math.max(1, Math.round(w)); ch = Math.max(1, Math.round(h));
      if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    }

    function draw(prims, scale, opts) {
      calls = 0;
      const wantPost = !!(opts && opts.post && opts.post.enabled);
      const pk = packPrims(prims, cw, ch, scale);
      // 有后处理时场景先画进离屏 FBO，再由后处理链合成到画布（否则直接画到画布）
      let fbo = null;
      let postOpts = null;
      if (wantPost) {
        const r = postCtx.ensure(cw, ch);
        if (r.caps.ok) { fbo = r.scene.fb; postOpts = opts.post; }
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.viewport(0, 0, cw, ch);
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      lastBlend = '';
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (!pk.count) {
        if (postOpts) { gl.bindFramebuffer(gl.FRAMEBUFFER, null); postCtx.run(postOpts); }
        return { calls: 0, instances: 0, prims: prims.length };
      }
      gl.useProgram(prog);
      gl.uniform2f(uRes, cw, ch);
      // 实例缓冲（除数为 1）
      gl.bindBuffer(gl.ARRAY_BUFFER, inst);
      if (pk.count * GL_STRIDE > cap) {
        cap = pk.count * 2;
        gl.bufferData(gl.ARRAY_BUFFER, cap * GL_STRIDE * F, gl.DYNAMIC_DRAW);
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, pk.data, 0, pk.count * GL_STRIDE);
      for (const name of attrs) { const l = A[name]; if (l >= 0) { gl.enableVertexAttribArray(l); gl.vertexAttribDivisor(l, 1); } }
      let instances = 0;
      for (const run of pk.runs) {
        setBlend(run.blend);
        bindAttrs(run.start);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, run.count);
        instances += run.count;
        calls++;
      }
      if (postOpts) {
        // 后处理用同一套顶点属性槽位 0，先把实例属性关掉（属性开关是全局状态，不分 program）
        for (const name of attrs) { const l = A[name]; if (l >= 0) gl.disableVertexAttribArray(l); }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        postCtx.run(postOpts);
      }
      return { calls, instances, prims: prims.length };
    }

    glRaster = {
      canvas, gl, resize, draw, locs: A,
      stats: () => ({ calls, instances: 0 }),
      kind: 'webgl2',
      renderer: (() => { const e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? String(gl.getParameter(e.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER)); })(),
    };
    return glRaster;
  } catch (e) {
    glRaster = null;
    return null;
  }
}

/** 供测试/诊断：强制重新探测（着色器改了也能重新生效） */
export function resetGLRaster() { tried = false; glRaster = null; }
