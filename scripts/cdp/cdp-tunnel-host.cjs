// 反向隧道（宿主机侧）+ 按需开洞控制协议。
//
// 为什么需要：Chromium 的 --remote-debugging-port 只监听 guest 的 127.0.0.1，
// VirtualBox NAT 的入站端口转发在 7.2.16 上不可靠（连上去只得 CloseWait），
// 所以让 guest 主动连宿主机。原先用"预建连接池"，但空闲连接会被静默回收，
// 池一空就拒连（实测 16 条池一分钟内全变 TimeWait）。改成按需：
//
//   控制连接(9226, guest→host 常连)：host 每次需要新隧道就往里写一个 'O'
//   隧道连接(9225, guest→host 按需)：guest 收到 'O' 就新开一条并接到 CDP
//   CDP 脚本(9330)：宿主侧每个客户端连接对应一条新隧道
//
// 用法：node cdp-tunnel-host.cjs   然后 CDP 脚本用 CDP_PORT=9330
'use strict';
const net = require('net');

const TUNNEL_PORT = Number(process.env.TUNNEL_PORT || 9225);
const CTRL_PORT = Number(process.env.CTRL_PORT || 9226);
const CLIENT_PORT = Number(process.env.CLIENT_PORT || 9330);

let ctrl = null;                 // 当前控制连接
const waiting = [];              // 等待中的隧道请求 {resolve, timer}

net.createServer((s) => {
  if (ctrl && !ctrl.destroyed) { try { ctrl.destroy(); } catch (e) {} }
  ctrl = s;
  console.log('[tunnel] guest 控制连接已建立');
  s.on('error', () => {});
  s.on('close', () => { if (ctrl === s) { ctrl = null; console.log('[tunnel] 控制连接断开'); } });
}).listen(CTRL_PORT, '127.0.0.1', () => console.log('[tunnel] 控制端口 ' + CTRL_PORT));

// 心跳：空闲连接会被 NAT/系统静默回收（实测数十秒级），双向各发一个字符保活。
// guest 只把 'O' 当开洞请求，'.' 直接忽略；这里对 guest 发来的 '.' 也忽略。
setInterval(() => {
  if (ctrl && !ctrl.destroyed) { try { ctrl.write('.'); } catch (e) {} }
}, 3000);

net.createServer((s) => {
  const w = waiting.shift();
  if (!w) { console.log('[tunnel] 收到未请求的隧道连接，丢弃'); s.destroy(); return; }
  clearTimeout(w.timer);
  w.resolve(s);
}).listen(TUNNEL_PORT, '127.0.0.1', () => console.log('[tunnel] 隧道端口 ' + TUNNEL_PORT));

function requestTunnel(timeoutMs = 15000) {
  if (!ctrl || ctrl.destroyed) throw new Error('guest 控制连接不存在（中继没起来？）');
  return new Promise((resolve, reject) => {
    const w = { resolve };
    w.timer = setTimeout(() => {
      const i = waiting.indexOf(w);
      if (i >= 0) waiting.splice(i, 1);
      reject(new Error('等隧道连接超时'));
    }, timeoutMs);
    waiting.push(w);
    ctrl.write('O');
  });
}

net.createServer(async (client) => {
  let t;
  try {
    t = await requestTunnel();
  } catch (e) {
    console.log('[tunnel] ' + e.message);
    client.destroy();
    return;
  }
  console.log('[tunnel] 配对成功');
  client.pipe(t);
  t.pipe(client);
  const bye = () => { try { client.destroy(); } catch (e) {} try { t.destroy(); } catch (e) {} };
  client.on('error', bye);
  t.on('error', bye);
  client.on('close', bye);
}).listen(CLIENT_PORT, '127.0.0.1', () => console.log('[tunnel] CDP 脚本请连 127.0.0.1:' + CLIENT_PORT));
