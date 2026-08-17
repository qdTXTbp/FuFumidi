// 生成 FuFumidi 安装程序用扁平化主题位图（24-bit BMP，无压缩）
// 风格：深色基底 + teal 强调，与应用设计语言一致
const fs = require('fs');
const path = require('path');

const OUT = __dirname;

function hex2rgb(h) {
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function lerp(a, b, t) { return Math.round(a + (b - a) * t); }
function lerp3(c1, c2, t) { return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)]; }

// 生成 BMP（24-bit，自下而上，每行 4 字节对齐）
function writeBMP(file, width, height, pixelFn) {
  const rowBytes = Math.ceil((width * 3) / 4) * 4;
  const dataSize = rowBytes * height;
  const fileSize = 54 + dataSize;
  const buf = Buffer.alloc(fileSize);
  // 文件头
  buf.write('BM', 0, 2, 'ascii');
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(54, 10);
  // 信息头
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(0, 30);
  buf.writeUInt32LE(dataSize, 34);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixelFn(x, y); // 0..255
      const row = height - 1 - y;      // bottom-up
      const off = 54 + row * rowBytes + x * 3;
      buf[off] = b; buf[off + 1] = g; buf[off + 2] = r;
    }
  }
  fs.writeFileSync(path.join(OUT, file), buf);
  console.log('written', file, width + 'x' + height, fileSize + 'B');
}

const bg0 = hex2rgb('0a0f18');  // 深底
const bg1 = hex2rgb('0d1522');  // 略亮
const card = hex2rgb('101a2a');
const teal = hex2rgb('00c9b1'); // 强调色
const teal2 = hex2rgb('00e6ca');

// 圆角矩形判断
function inRoundRect(x, y, rx, ry, w, h, r) {
  if (x < rx || x >= rx + w || y < ry || y >= ry + h) return false;
  const cx = x < rx + r ? rx + r : (x > rx + w - 1 - r ? rx + w - 1 - r : x);
  const cy = y < ry + r ? ry + r : (y > ry + h - 1 - r ? ry + h - 1 - r : y);
  const dx = x - cx, dy = y - cy;
  return (dx * dx + dy * dy) <= r * r + 1;
}

// ---------- 顶部横幅 150x57 ----------
writeBMP('installer-header.bmp', 150, 57, (x, y) => {
  let c = lerp3(bg1, bg0, y / 56);
  // 右侧 teal 柔和光晕（扁平渐变）
  const gx = x - 118, gy = y - 20;
  const d = Math.sqrt(gx * gx + gy * gy);
  if (d < 46) c = lerp3(c, teal, 0.30 * (1 - d / 46));
  // 左侧品牌「F」徽标（扁平圆角方块 + 负空间 F，与应用内 logo 同源）
  if (inRoundRect(x, y, 12, 14, 30, 30, 8)) {
    c = lerp3(teal, teal2, 0.5);
    if ((x >= 21 && x < 28 && y >= 21 && y < 37) ||      // F 竖
        (x >= 21 && x < 33 && y >= 21 && y < 26) ||      // F 上横
        (x >= 21 && x < 31 && y >= 29 && y < 33)) {      // F 中横
      c = bg0;
    }
  }
  // 底部强调条
  if (y >= 53) c = lerp3(teal, teal2, x / 149);
  return c;
});

// ---------- 欢迎/完成页左侧品牌图 164x314 ----------
function brandImage() {
  return (x, y) => {
    let c = lerp3(card, bg0, y / 313);
    // 顶部 teal 光晕
    const d1 = Math.sqrt((x - 82) * (x - 82) + (y - 40) * (y - 40));
    if (d1 < 70) c = lerp3(c, teal, 0.18 * (1 - d1 / 70));
    // 中央品牌方块（扁平）
    if (inRoundRect(x, y, 46, 108, 72, 72, 16)) {
      const t = (x - 46) / 71;
      c = lerp3(teal, teal2, 0.5);
      // 内部留一个“F”形态的负空间：四块深色矩形
      const dark = bg0;
      if ((x >= 60 && x < 76 && y >= 122 && y < 156) ||   // 竖
          (x >= 60 && x < 92 && y >= 122 && y < 133)) {    // 横
        c = dark;
      }
    }
    // 底部强调条
    if (y >= 309) c = lerp3(teal, teal2, x / 163);
    return c;
  };
}
writeBMP('installer-welcome.bmp', 164, 314, brandImage());
writeBMP('installer-finish.bmp', 164, 314, brandImage());
