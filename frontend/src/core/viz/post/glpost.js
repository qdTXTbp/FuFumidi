// ============================================================
// 着色器后处理（可视化重做 · 后处理层 · M3）
//
// 取代 Canvas2D 版的 post/bloom2d.js（那一版只能"缩到 1/4 + 自乘做阈值"，
// 单层模糊 + 阈值是"糊"，不是"发光"）。这里按参考工程的做法：
//   ① 阈值化（软膝）→ ② 三层倍频带（1/2、1/4、1/8）各自高斯分离模糊
//   → ③ 权重 0.30/0.20/0.11 累加 → ④ 加进场景 → ⑤ 调色（蓝通道 lift 抬最多）
//   → ⑥ tanh 肩部色调映射（拐点以下恒等，白点落在 0.95）
// 全程在 GPU 上、分辨率无关；导出的 4K 帧与预览走同一条链。
//
// 为什么必须换掉 canvas 后处理：canvas 的 blur/自乘是 8 位、非线性空间里的近似，
// 既做不出"三层倍频带"，也做不出"肩部映射"，亮部一律糊成一片白。
// ============================================================

const VS = `#version 300 es
in vec2 aPos;
out vec2 vUV;
void main() { vUV = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

// 阈值 + 软膝：只在亮度超过阈值处取光，膝部避免出现硬边（硬阈值 = 一圈突兀的亮边）
const FS_BRIGHT = `#version 300 es
precision highp float;
in vec2 vUV; out vec4 outColor;
uniform sampler2D uTex; uniform float uThr; uniform float uKnee;
void main() {
  vec4 s = texture(uTex, vUV);
  float l = max(s.r, max(s.g, s.b));
  float k = smoothstep(uThr, uThr + max(0.001, uKnee), l);
  outColor = vec4(s.rgb * k, s.a * k);
}`;

const FS_DOWN = `#version 300 es
precision highp float;
in vec2 vUV; out vec4 outColor;
uniform sampler2D uTex; uniform vec2 uTexel;
void main() {
  vec4 c = texture(uTex, vUV + vec2(-uTexel.x, -uTexel.y));
  c += texture(uTex, vUV + vec2(uTexel.x, -uTexel.y));
  c += texture(uTex, vUV + vec2(-uTexel.x, uTexel.y));
  c += texture(uTex, vUV + vec2(uTexel.x, uTexel.y));
  outColor = c * 0.25;
}`;

// 9 抽头高斯（σ≈2），分离成水平/垂直两趟
const FS_BLUR = `#version 300 es
precision highp float;
in vec2 vUV; out vec4 outColor;
uniform sampler2D uTex; uniform vec2 uDir;
void main() {
  vec4 c = texture(uTex, vUV) * 0.227027;
  c += (texture(uTex, vUV + uDir * 1.0) + texture(uTex, vUV - uDir * 1.0)) * 0.1945946;
  c += (texture(uTex, vUV + uDir * 2.0) + texture(uTex, vUV - uDir * 2.0)) * 0.1216216;
  c += (texture(uTex, vUV + uDir * 3.0) + texture(uTex, vUV - uDir * 3.0)) * 0.0540540;
  c += (texture(uTex, vUV + uDir * 4.0) + texture(uTex, vUV - uDir * 4.0)) * 0.0162162;
  outColor = c;
}`;

const FS_COMP = `#version 300 es
precision highp float;
in vec2 vUV; out vec4 outColor;
uniform sampler2D uScene; uniform sampler2D uB1; uniform sampler2D uB2; uniform sampler2D uB3;
uniform vec3 uW; uniform float uBloom;
uniform vec3 uLift; uniform vec3 uGain; uniform float uSat; uniform float uExposure;

// 拐点以下恒等、肩部 tanh；k+span=0.95 → 白点落在 0.95 而不是死白 1.0
vec3 tonemap(vec3 x) {
  const float k = 0.63, span = 0.32;
  vec3 t = k + span * tanh((x - k) / span);
  return mix(x, t, step(vec3(k), x));
}

void main() {
  vec4 c = texture(uScene, vUV);
  vec3 b = texture(uB1, vUV).rgb * uW.x + texture(uB2, vUV).rgb * uW.y + texture(uB3, vUV).rgb * uW.z;
  float ba = texture(uB1, vUV).a * uW.x + texture(uB2, vUV).a * uW.y + texture(uB3, vUV).a * uW.z;
  float cov = clamp(c.a + ba * uBloom, 0.0, 1.0);
  vec3 x = c.rgb + b * uBloom;                 // 泛光加进"加色光层"，再走色调映射
  // 调色：蓝通道 lift/gain 抬得最多，暗部保持靛蓝。
  // ★ lift 乘 cov：否则整幅透明区也会被抬出非零 RGB（alpha=0 却有色），透明导出会出现脏底。
  x = x * uExposure * uGain + uLift * cov;
  float l = dot(x, vec3(0.2126, 0.7152, 0.0722));
  x = mix(vec3(l), x, uSat);
  x = tonemap(max(x, 0.0));
  outColor = vec4(x, cov);
}`;

const BASE_POST = {
  bloom: 0, thr: 0.55, knee: 0.26,
  lift: [0.003, 0.006, 0.020], gain: [1.0, 1.012, 1.055], sat: 1.07, exposure: 1.0,
  weights: [0.30, 0.20, 0.11],
};

function makeProgram(gl, fs) {
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { const log = gl.getShaderInfoLog(s); gl.deleteShader(s); throw new Error('post shader: ' + log); }
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('post link: ' + gl.getProgramInfoLog(p));
  const u = (n) => gl.getUniformLocation(p, n);
  return { p, u: { tex: u('uTex'), texel: u('uTexel'), dir: u('uDir'), thr: u('uThr'), knee: u('uKnee'), scene: u('uScene'), b1: u('uB1'), b2: u('uB2'), b3: u('uB3'), w: u('uW'), bloom: u('uBloom'), lift: u('uLift'), gain: u('uGain'), sat: u('uSat'), exposure: u('uExposure'), aPos: gl.getAttribLocation(p, 'aPos') } };
}

/** 建一张离屏目标（纹理 + FBO），尺寸变化时重建 */
function makeTarget(gl, w, h) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, Math.max(1, w), Math.max(1, h), 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { tex, fb, w: Math.max(1, w), h: Math.max(1, h), ok };
}

export function createGLPost(gl) {
  let prog = null;
  let quad = null;
  let scene = null, bright = null, o1 = null, t1 = null, o2 = null, t2 = null, o3 = null, t3 = null;
  let caps = null;

  function init() {
    if (prog) return prog;
    prog = { bright: makeProgram(gl, FS_BRIGHT), down: makeProgram(gl, FS_DOWN), blur: makeProgram(gl, FS_BLUR), comp: makeProgram(gl, FS_COMP) };
    quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    return prog;
  }

  function ensure(w, h) {
    init();
    const need = (t, tw, th) => (!t || t.w !== tw || t.h !== th);
    const sized = (cur, tw, th) => (need(cur, tw, th) ? makeTarget(gl, tw, th) : cur);
    const h2w = Math.max(1, w >> 1), h2h = Math.max(1, h >> 1);
    const q2w = Math.max(1, w >> 2), q2h = Math.max(1, h >> 2);
    const q3w = Math.max(1, w >> 3), q3h = Math.max(1, h >> 3);
    scene = sized(scene, w, h);
    bright = sized(bright, h2w, h2h);
    o1 = sized(o1, h2w, h2h); t1 = sized(t1, h2w, h2h);
    o2 = sized(o2, q2w, q2h); t2 = sized(t2, q2w, q2h);
    o3 = sized(o3, q3w, q3h); t3 = sized(t3, q3w, q3h);
    const all = [scene, bright, o1, t1, o2, t2, o3, t3];
    caps = { ok: all.every((t) => t.ok), w, h };
    return { scene, caps };
  }

  function bindQuad(aPos) {
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 8, 0);
    gl.vertexAttribDivisor(aPos, 0);
  }

  function drawTo(target, pgm, setup) {
    if (target) gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
    else gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const w = target ? target.w : caps.w, h = target ? target.h : caps.h;
    gl.viewport(0, 0, w, h);
    gl.useProgram(pgm.p);
    bindQuad(pgm.u.aPos);
    gl.activeTexture(gl.TEXTURE0);
    setup(pgm);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  const bind = (unit, tex, loc) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(loc, unit); };

  /** 场景已经画进 scene 纹理后调用：跑完整后处理链并输出到默认帧缓冲 */
  function run(opts = {}) {
    const o = Object.assign({}, BASE_POST, opts);
    const w = caps.w, h = caps.h;
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);

    // ① 阈值（半分辨率）
    drawTo(bright, prog.bright, (pg) => { bind(0, scene.tex, pg.u.tex); gl.uniform1f(pg.u.thr, o.thr); gl.uniform1f(pg.u.knee, o.knee); });
    // ② 三层倍频带：各自下采样 + 分离模糊
    // 分离模糊：水平写进各自的临时目标，垂直再读回来写进正式目标 ——
    // 同一张纹理不能同时当输入和输出（WebGL 下是未定义行为），所以每层各配一张临时贴图。
    const blurTo = (dst, tmp, src, spread) => {
      drawTo(tmp, prog.blur, (pg) => { bind(0, src.tex, pg.u.tex); gl.uniform2f(pg.u.dir, spread / dst.w, 0); });
      drawTo(dst, prog.blur, (pg) => { bind(0, tmp.tex, pg.u.tex); gl.uniform2f(pg.u.dir, 0, spread / dst.h); });
    };
    drawTo(o1, prog.down, (pg) => { bind(0, bright.tex, pg.u.tex); gl.uniform2f(pg.u.texel, 1 / bright.w, 1 / bright.h); });
    blurTo(o1, t1, o1, 1.6);
    drawTo(o2, prog.down, (pg) => { bind(0, o1.tex, pg.u.tex); gl.uniform2f(pg.u.texel, 1 / o1.w, 1 / o1.h); });
    blurTo(o2, t2, o2, 2.4);
    drawTo(o3, prog.down, (pg) => { bind(0, o2.tex, pg.u.tex); gl.uniform2f(pg.u.texel, 1 / o2.w, 1 / o2.h); });
    blurTo(o3, t3, o3, 3.2);
    // ③④⑤⑥ 合成到画布
    drawTo(null, prog.comp, (pg) => {
      bind(0, scene.tex, pg.u.scene); bind(1, o1.tex, pg.u.b1); bind(2, o2.tex, pg.u.b2); bind(3, o3.tex, pg.u.b3);
      gl.uniform3f(pg.u.w, o.weights[0], o.weights[1], o.weights[2]);
      gl.uniform1f(pg.u.bloom, o.bloom);
      gl.uniform3f(pg.u.lift, o.lift[0], o.lift[1], o.lift[2]);
      gl.uniform3f(pg.u.gain, o.gain[0], o.gain[1], o.gain[2]);
      gl.uniform1f(pg.u.sat, o.sat);
      gl.uniform1f(pg.u.exposure, o.exposure);
    });
    gl.enable(gl.BLEND);
    return { w, h };
  }

  return { init, ensure, run, get sceneTarget() { return scene; } };
}

export const GL_POST_DEFAULTS = BASE_POST;
