#!/usr/bin/env node
/**
 * 优选生成器 - Vless 节点批量优选工具（单文件，浏览器 + Node 双环境）
 *
 * 功能：
 *   根据一个 vless 节点链接 + 多个优选地址（IP/域名）+ 多个端口号，
 *   批量替换节点的 address:port 部分，生成 N × M 个优选节点，
 *   节点名自动递增编号，所有节点拼接后整体 base64 编码输出（单个连续字符串，可直接导入 v2rayN）。
 *
 * ── 浏览器（index.html 引用本文件）──
 *   正常访问 index.html           → 构建前端界面，输入生成节点 + 订阅地址
 *   访问 index.html?u=...&i=...&t=... → 订阅模式：直接输出纯 base64 节点文本（无 UI、无 HTML 标签）
 *
 * ── Node.js CLI ──
 *   用法 1（交互模式，默认）：
 *     node 优选生成器.js
 *   用法 2（命令行参数）：
 *     node 优选生成器.js "vless://UUID@host:port?params#name" "443,8443" "addr1 addr2"
 *   作为模块：
 *     const { generate } = require('./优选生成器');
 *     const result = generate(link, ['1.1.1.1', '2.2.2.2'], [443, 8443]);
 */

'use strict';

// ===========================================================================
// 核心函数（浏览器 / Node 通用）
// ===========================================================================

/**
 * Base64 编码（UTF-8 安全）
 * Node 用 Buffer，浏览器用 btoa
 */
function b64Encode(s) {
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    return Buffer.from(String(s), 'utf-8').toString('base64');
  }
  return btoa(unescape(encodeURIComponent(String(s))));
}

/**
 * Base64 解码（UTF-8 安全）
 */
function b64Decode(s) {
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    return Buffer.from(String(s), 'base64').toString('utf-8');
  }
  return decodeURIComponent(escape(atob(String(s))));
}

/**
 * 规范化输入：接受明文 vless 链接或 base64 编码的 vless 链接
 */
function normalizeInput(link) {
  if (typeof link !== 'string') throw new Error('输入必须是字符串');
  const s = link.trim();
  if (!s) throw new Error('输入为空');
  if (s.startsWith('vless://')) return s;
  try {
    const d = b64Decode(s).trim();
    if (d.startsWith('vless://')) return d;
  } catch (_) { /* ignore */ }
  throw new Error('不是有效的 vless 链接（既不是明文也不是 base64）');
}

/**
 * 解析 vless 链接
 * 格式: vless://UUID@ADDRESS:PORT?PARAMS#NAME
 * @returns {{uuid:string,address:string,port:string,params:string,name:string}}
 */
function parseVless(link) {
  const s = normalizeInput(link);
  const rest = s.slice('vless://'.length);

  // 1. 分离 name（# 之后）
  const hashIdx = rest.indexOf('#');
  const beforeName = hashIdx >= 0 ? rest.slice(0, hashIdx) : rest;
  const name = hashIdx >= 0 ? rest.slice(hashIdx + 1) : '';

  // 2. 分离 params（? 之后，含 ?）
  const qIdx = beforeName.indexOf('?');
  const beforeParams = qIdx >= 0 ? beforeName.slice(0, qIdx) : beforeName;
  const params = qIdx >= 0 ? beforeName.slice(qIdx) : '';

  // 3. 分离 uuid 与 address:port
  const atIdx = beforeParams.indexOf('@');
  if (atIdx < 0) throw new Error('vless 链接格式错误：缺少 @');
  const uuid = beforeParams.slice(0, atIdx);
  const addrPort = beforeParams.slice(atIdx + 1);

  // 4. 分离 address 与 port（支持 IPv6 [addr]:port）
  let address, port;
  if (addrPort.startsWith('[')) {
    const closeIdx = addrPort.indexOf(']');
    if (closeIdx < 0) throw new Error('IPv6 地址格式错误（缺少 ]）');
    address = addrPort.slice(1, closeIdx);
    port = addrPort.slice(closeIdx + 1).replace(/^:/, '');
  } else {
    const colonIdx = addrPort.lastIndexOf(':');
    if (colonIdx < 0) throw new Error('地址格式错误：缺少端口分隔符 :');
    address = addrPort.slice(0, colonIdx);
    port = addrPort.slice(colonIdx + 1);
  }

  if (!uuid) throw new Error('UUID 为空');
  if (!address) throw new Error('地址为空');
  if (!port) throw new Error('端口为空');

  return { uuid, address, port, params, name };
}

/**
 * 根据索引生成递增节点名
 * 规则：
 *   - 原名为空 → node_1, node_2, ...
 *   - 原名以 _数字 结尾（如 snippet_1）→ snippet_1, snippet_2, ...
 *   - 原名不以 _数字 结尾（如 My Node）→ My Node_1, My Node_2, ...
 */
function generateName(originalName, index) {
  if (!originalName) return `node_${index + 1}`;
  const match = originalName.match(/^(.*)_(\d+)$/);
  if (match) return `${match[1]}_${index + 1}`;
  return `${originalName}_${index + 1}`;
}

/**
 * 构建新的 vless 链接（替换 address 和 port，自动递增节点名）
 */
function buildVless(originalLink, newAddress, newPort, nameIndex) {
  const p = parseVless(originalLink);
  newAddress = String(newAddress).trim();
  newPort = String(newPort).trim();
  if (!newAddress) throw new Error('地址为空');
  if (!newPort) throw new Error('端口为空');
  const addr = newAddress.includes(':') ? `[${newAddress}]` : newAddress;
  const name = generateName(p.name, nameIndex);
  const namePart = name ? `#${name}` : '';
  return `vless://${p.uuid}@${addr}:${newPort}${p.params}${namePart}`;
}

/**
 * 生成所有优选节点
 * 每个优选地址 × 每个端口 笛卡尔积组合，节点名自动递增编号，
 * 所有明文链接拼接（每个结尾 \r\n）后整体 base64 编码，返回单个连续字符串。
 * @returns {{base64:string, plainText:string, items:object[], count:number}}
 */
function generate(originalLink, preferredAddresses, ports) {
  if (!Array.isArray(preferredAddresses) || preferredAddresses.length === 0) {
    throw new Error('优选地址列表为空');
  }
  if (!Array.isArray(ports) || ports.length === 0) {
    throw new Error('端口列表为空');
  }

  const items = [];
  let counter = 0;
  for (const addr of preferredAddresses) {
    if (!addr || !String(addr).trim()) continue;
    for (const port of ports) {
      if (port === '' || port === null || port === undefined) continue;
      const newLink = buildVless(originalLink, addr, port, counter);
      items.push({ plain: newLink, index: counter });
      counter++;
    }
  }

  const plainText = items.map(item => item.plain + '\r\n').join('');
  return {
    base64: b64Encode(plainText),
    plainText: plainText,
    items: items,
    count: items.length
  };
}

/**
 * 拆分列表字符串：支持 ~（订阅链接用）、逗号、空格、制表符分隔
 */
function splitList(raw) {
  return String(raw).split(/[~,\s]+/).filter(Boolean);
}

// ===========================================================================
// 订阅链接参数（浏览器使用；纯函数部分 Node 也可用）
// ===========================================================================

/**
 * 从 vless 链接提取订阅所需的关键参数
 */
function extractParams(link) {
  const p = parseVless(link);
  const q = p.params.slice(1);
  const query = {};
  for (const pair of q.split('&')) {
    const eq = pair.indexOf('=');
    if (eq >= 0) query[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  const nm = p.name.match(/^(.*)_\d+$/);
  let path = query.path || '';
  try { path = decodeURIComponent(path); } catch (_) {}
  return {
    u: p.uuid,
    s: query.sni || '',
    h: query.host || '',
    p: path,
    f: query.fp || '',
    n: nm ? nm[1] : p.name,
    sec: query.security || '',
    ty: query.type || ''
  };
}

/**
 * 根据订阅参数重建 vless 链接（address 用占位符，生成时替换）
 */
function rebuildVlessFromParams(params) {
  const sni = params.s || params.h || '';
  const host = params.h || params.s || '';
  const path = params.p || '/';
  const fp = params.f || 'chrome';
  const sec = params.sec || 'tls';
  const ty = params.ty || 'ws';
  const name = params.n || '';
  return 'vless://' + params.u + '@localhost:443?encryption=none&security=' + sec +
    '&sni=' + sni + '&fp=' + fp + '&type=' + ty + '&host=' + host +
    '&path=' + encodeURIComponent(path) + (name ? '#' + name : '');
}

/**
 * 读取 URL 参数（浏览器）
 * @returns {null | {link:string, addresses:string, ports:string}}
 */
function readUrlParams() {
  const sp = new URLSearchParams(window.location.search);
  const u = sp.get('u'), s = sp.get('s'), h = sp.get('h'), p = sp.get('p'),
        f = sp.get('f'), n = sp.get('n'), sec = sp.get('sec'), ty = sp.get('ty'),
        i = sp.get('i'), t = sp.get('t');
  if (!u && !s && !i && !t) return null;
  return {
    uuid: u,
    link: rebuildVlessFromParams({ u, s, h, p, f, n, sec, ty }),
    addresses: i ? i.replace(/[~,\s]+/g, '\n') : '',
    ports: t ? t.replace(/[~,\s]+/g, '\n') : ''
  };
}

// ===========================================================================
// Service Worker：拦截带订阅参数的请求，返回纯 text/plain base64（无 HTML）
// 同一个 JS 文件被 navigator.serviceWorker.register() 加载为 SW 脚本
// ===========================================================================

if (typeof self !== 'undefined' && typeof window === 'undefined') {
  // SW 环境：self 存在但 window 不存在
  self.addEventListener('install', function (e) { self.skipWaiting(); });
  self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

  self.addEventListener('fetch', function (e) {
    var url = new URL(e.request.url);
    var sp = url.searchParams;
    var u = sp.get('u'), i = sp.get('i'), t = sp.get('t');

    // 拦截带完整订阅参数的请求 → 返回纯 base64 文本
    if (u && i && t) {
      try {
        var link = rebuildVlessFromParams({
          u: u, s: sp.get('s'), h: sp.get('h'), p: sp.get('p'),
          f: sp.get('f'), n: sp.get('n'), sec: sp.get('sec'), ty: sp.get('ty')
        });
        var r = generate(link, splitList(i), splitList(t));
        e.respondWith(new Response(r.base64, {
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        }));
      } catch (err) {
        e.respondWith(new Response('Error: ' + err.message, {
          status: 500,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        }));
      }
    }
    // 不带参数的请求不拦截，正常返回 index.html
  });
}

// ===========================================================================
// Node.js：导出模块 + CLI
// ===========================================================================

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    normalizeInput,
    parseVless,
    buildVless,
    generateName,
    b64Encode,
    b64Decode,
    generate,
    splitList,
    extractParams,
    rebuildVlessFromParams,
  };
}

if (typeof require !== 'undefined' && typeof require.main !== 'undefined' && require.main === module) {
  // ── 交互模式 ──
  function runInteractive() {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

    (async () => {
      let closed = false;
      try {
        console.log('========================================');
        console.log('        优选生成器 - Vless 节点批量优选');
        console.log('========================================');
        console.log('（输入 vless:// 开头的明文链接，或 base64 编码链接）');
        console.log('');

        const link = (await ask('\n请输入单节点 vless 链接: ')).trim();
        const portsRaw = (await ask('请输入端口号（多个用逗号或空格分隔，如 443,8443）: ')).trim();
        const addrsRaw = (await ask('请输入优选 IP/域名（多个用空格或换行分隔）: ')).trim();

        closed = true;
        rl.close();

        const ports = splitList(portsRaw);
        const addrs = splitList(addrsRaw);
        if (ports.length === 0) throw new Error('端口列表为空');
        if (addrs.length === 0) throw new Error('优选地址列表为空');

        const result = generate(link, addrs, ports);
        console.log('');
        console.log(`=== 生成结果（共 ${result.count} 个节点）===`);
        console.log('base64（单个连续字符串，可直接导入 v2rayN）:');
        console.log(result.base64);
        console.log('');
        console.log('明文 vless 链接:');
        console.log(result.plainText);
      } catch (e) {
        if (!closed) rl.close();
        console.error('错误:', e.message);
        process.exit(1);
      }
    })();
  }

  // ── 命令行参数模式 ──
  function runFromArgs(argv) {
    if (argv.length < 3) {
      console.error('用法: node 优选生成器.js <vless链接> <端口列表> <优选地址列表>');
      console.error('  端口列表用逗号或空格分隔，如 "443,8443"');
      console.error('  优选地址列表用空格分隔，如 "1.1.1.1 2.2.2.2 example.com"');
      process.exit(1);
    }
    const link = argv[0];
    const ports = splitList(argv[1]);
    const addrs = argv.slice(2).join(' ').split(/\s+/).filter(Boolean);
    if (ports.length === 0) { console.error('错误: 端口列表为空'); process.exit(1); }
    if (addrs.length === 0) { console.error('错误: 优选地址列表为空'); process.exit(1); }

    const result = generate(link, addrs, ports);
    console.log(`=== 生成结果（共 ${result.count} 个节点）===`);
    console.log('base64（单个连续字符串，可直接导入 v2rayN）:');
    console.log(result.base64);
    console.log('');
    console.log('明文 vless 链接:');
    console.log(result.plainText);
  }

  const argv = process.argv.slice(2);
  if (argv.length >= 3) runFromArgs(argv);
  else runInteractive();
}

// ===========================================================================
// 浏览器：订阅端点 + 前端界面（index.html 为空壳，所有 UI 由本文件构建）
// ===========================================================================

if (typeof window !== 'undefined') {
  (function () {
    'use strict';

    var params = readUrlParams();

    // ── 订阅模式 ──
    // 注册 SW；SW 激活后拦截请求返回纯 text/plain base64（无任何 HTML 标签）
    if (params && params.uuid && params.addresses && params.ports) {
      try {
        var r = generate(params.link, splitList(params.addresses), splitList(params.ports));
      } catch (e) {
        document.write('Error: ' + e.message);
        return;
      }

      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('优选生成器.js').then(function (reg) {
          if (navigator.serviceWorker.controller) {
            // SW 已控制页面，刷新让 SW 拦截返回纯文本
            location.reload();
          } else {
            // 等待 SW 激活后刷新
            navigator.serviceWorker.addEventListener('controllerchange', function () {
              location.reload();
            });
            // 同时先输出 base64（fallback，有 html 结构，但 SW 激活后刷新即变纯文本）
            document.write(r.base64);
          }
        }).catch(function () {
          document.write(r.base64);
        });
      } else {
        // 不支持 SW，直接输出
        document.write(r.base64);
      }
      return;
    }

    // ── 正常模式：后台注册 SW + 构建界面 ──
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('优选生成器.js').catch(function () {});
    }

    // ── 界面样式 ──
    var UI_CSS =
      ':root{--bg:#0f1117;--bg-elev:#1a1d27;--bg-input:#242836;--border:#2e3346;--text:#e4e6ef;--text-dim:#8b8fa3;--accent:#5b9dff;--accent-hover:#7ab0ff;--accent-glow:rgba(91,157,255,.25);--success:#4ade80;--danger:#f87171;--warning:#fbbf24;--radius:10px}' +
      '*{box-sizing:border-box;margin:0;padding:0}' +
      'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",Roboto,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;padding:24px 16px;line-height:1.6}' +
      '.container{max-width:960px;margin:0 auto}' +
      'header{text-align:center;margin-bottom:24px;padding:20px 0}' +
      'header h1{font-size:26px;font-weight:700;background:linear-gradient(135deg,#5b9dff,#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;margin-bottom:4px}' +
      'header p{color:var(--text-dim);font-size:14px}' +
      '.card{background:var(--bg-elev);border:1px solid var(--border);border-radius:var(--radius);padding:18px;margin-bottom:16px}' +
      '.card h2{font-size:15px;font-weight:600;margin-bottom:12px;display:flex;align-items:center;gap:8px}' +
      '.card h2 .num{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:var(--accent);color:#fff;font-size:13px;font-weight:700}' +
      'label{display:block;font-size:13px;color:var(--text-dim);margin-bottom:6px}' +
      'textarea{width:100%;background:var(--bg-input);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:12px 14px;font-size:14px;font-family:"SF Mono","Cascadia Code",Consolas,monospace;resize:vertical;transition:border-color .2s,box-shadow .2s;outline:none}' +
      'textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-glow)}' +
      'textarea{min-height:88px}' +
      '.hint{font-size:12px;color:var(--text-dim);margin-top:6px;line-height:1.5}' +
      '.hint code{background:var(--bg-input);padding:1px 6px;border-radius:4px;font-size:11px}' +
      '.btn-group{display:flex;gap:10px;flex-wrap:wrap;align-items:center}' +
      'button{background:var(--accent);color:#fff;border:none;border-radius:8px;padding:12px 24px;font-size:14px;font-weight:600;cursor:pointer;transition:all .2s;display:inline-flex;align-items:center;gap:8px}' +
      'button:hover{background:var(--accent-hover);transform:translateY(-1px)}' +
      'button:active{transform:translateY(0)}' +
      'button:disabled{opacity:.5;cursor:not-allowed;transform:none}' +
      'button.secondary{background:var(--bg-input);border:1px solid var(--border);color:var(--text)}' +
      'button.secondary:hover{background:var(--border)}' +
      '.btn-group.primary{justify-content:center;margin:8px 0 18px}' +
      '#generateBtn{background:linear-gradient(135deg,#5b9dff,#a78bfa);padding:14px 40px;font-size:15px;box-shadow:0 4px 20px var(--accent-glow)}' +
      '.output-area{position:relative}' +
      '.output-area textarea{min-height:180px;word-break:break-all}' +
      '#outputBase64{color:var(--success)}' +
      '#outputPlain{color:var(--warning)}' +
      '.output-toolbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:10px}' +
      '.stats{font-size:13px;color:var(--text-dim)}' +
      '.stats .count{color:var(--accent);font-weight:700;font-size:16px}' +
      '.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(100px);background:var(--bg-elev);border:1px solid var(--success);color:var(--success);padding:12px 24px;border-radius:8px;font-size:14px;box-shadow:0 8px 30px rgba(0,0,0,.4);transition:transform .3s;z-index:1000}' +
      '.toast.show{transform:translateX(-50%) translateY(0)}' +
      '.section-label{font-size:13px;font-weight:600;color:var(--text);margin-bottom:8px;display:flex;align-items:center;gap:8px}' +
      '.section-label .tag{font-size:11px;padding:2px 8px;border-radius:4px;font-weight:600}' +
      '.tag-b64{background:rgba(74,222,128,.15);color:var(--success)}' +
      '.tag-plain{background:rgba(251,191,36,.15);color:var(--warning)}' +
      '.tag-url{background:rgba(91,157,255,.15);color:var(--accent)}' +
      '.toggle-row{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-dim);margin:14px 0 4px}' +
      '.toggle-row input[type=checkbox]{width:16px;height:16px;accent-color:var(--accent);cursor:pointer}' +
      '.error-msg{color:var(--danger);font-size:13px;margin-top:10px;padding:10px 14px;background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.3);border-radius:8px;display:none}' +
      '.error-msg.show{display:block}' +
      'footer{text-align:center;color:var(--text-dim);font-size:12px;margin-top:32px;padding-top:18px;border-top:1px solid var(--border)}' +
      '.format-note{font-size:12px;color:var(--text-dim);margin-top:8px;padding:8px 12px;background:rgba(91,157,255,.08);border-left:3px solid var(--accent);border-radius:4px}' +
      '.format-note b{color:var(--accent)}' +
      '.url-length{font-size:12px;color:var(--text-dim);margin-top:6px}' +
      '.url-length b{color:var(--warning)}';

    // ── 界面标记 ──
    var UI_HTML =
      '<div class="container">' +
        '<header>' +
          '<h1>⚡ 优选生成器</h1>' +
          '<p>Vless 节点批量优选 · 一键生成 base64 订阅</p>' +
        '</header>' +
        '<div class="card">' +
          '<h2><span class="num">1</span> 原始节点链接</h2>' +
          '<label for="inputLink">粘贴单条 vless 链接（明文或 base64 均可）</label>' +
          '<textarea id="inputLink" placeholder="vless://56c61d17-676b-4941-b6ef-5648b16b3d22@dy2.galloner1.eu.org:443?encryption=none&security=tls&sni=dy2.galloner1.eu.org&fp=chrome&type=ws&host=dy2.galloner1.eu.org&path=%2F%3Fed%3D2048#snippet_1"></textarea>' +
          '<div class="hint">支持直接粘贴 <code>vless://...</code> 明文链接，或 base64 编码链接（自动解码）。</div>' +
        '</div>' +
        '<div class="card">' +
          '<h2><span class="num">2</span> 优选地址（IP / 域名）</h2>' +
          '<label for="inputAddresses">每个地址生成一组节点</label>' +
          '<textarea id="inputAddresses" placeholder="104.24.5.149&#10;bestcf.030101.xyz&#10;example.com"></textarea>' +
          '<div class="hint">每行一个地址，或用空格 / 逗号分隔。</div>' +
        '</div>' +
        '<div class="card">' +
          '<h2><span class="num">3</span> 端口号</h2>' +
          '<label for="inputPorts">每个端口都会与每个地址组合</label>' +
          '<textarea id="inputPorts" style="min-height:56px" placeholder="443,8443,2053"></textarea>' +
          '<div class="hint">多个端口用逗号或空格分隔，如 <code>443,8443,2053</code>。</div>' +
        '</div>' +
        '<div class="btn-group primary">' +
          '<button id="generateBtn">🚀 一键生成优选节点</button>' +
        '</div>' +
        '<div class="card">' +
          '<div class="output-toolbar">' +
            '<h2 style="margin:0"><span class="num">✓</span> 生成结果</h2>' +
            '<div class="stats">共 <span class="count" id="count">0</span> 个节点</div>' +
          '</div>' +
          '<div class="error-msg" id="errorMsg"></div>' +
          '<div class="format-note">base64 输出为<b>单个连续字符串</b>（所有节点拼接后整体编码），可直接复制导入 v2rayN。</div>' +
          '<div class="section-label" style="margin-top:14px"><span class="tag tag-b64">base64</span> 订阅链接（单个字符串，可直接导入）</div>' +
          '<div class="output-area"><textarea id="outputBase64" readonly placeholder="生成的 base64 订阅链接将显示在此处..."></textarea></div>' +
          '<div id="subUrlSection" style="display:none">' +
            '<div class="section-label" style="margin-top:14px"><span class="tag tag-url">url</span> 订阅地址（访问即返回节点数据）</div>' +
            '<div class="output-area"><textarea id="subUrlDisplay" readonly style="min-height:52px;font-size:12px" placeholder="订阅地址将显示在此处..."></textarea></div>' +
            '<div class="url-length">URL 长度：<b id="urlLen">0</b> 字符</div>' +
          '</div>' +
          '<div class="toggle-row"><label><input type="checkbox" id="showPlain"> 显示明文 vless 链接</label></div>' +
          '<div id="plainSection" style="display:none">' +
            '<div class="section-label"><span class="tag tag-plain">plain</span> 明文 vless 链接（每行一个节点）</div>' +
            '<div class="output-area"><textarea id="outputPlain" readonly placeholder="明文 vless 链接将显示在此处..."></textarea></div>' +
          '</div>' +
          '<div class="btn-group" style="margin-top:14px">' +
            '<button class="secondary" id="copyBtn">📋 复制 base64</button>' +
            '<button class="secondary" id="copySubBtn">🔗 复制订阅地址</button>' +
            '<button class="secondary" id="copyPlainBtn">📋 复制明文</button>' +
            '<button class="secondary" id="downloadBtn">💾 下载</button>' +
            '<button class="secondary" id="clearBtn">🗑️ 清空</button>' +
          '</div>' +
        '</div>' +
        '<footer>优选生成器 · 纯前端本地运行 · 数据不会离开你的浏览器</footer>' +
      '</div>' +
      '<div class="toast" id="toast"></div>';

    // ── DOM 工具 ──
    function $(id) { return document.getElementById(id); }
    var _subUrl = '';

    function showToast(m) {
      var t = $('toast');
      t.textContent = m;
      t.classList.add('show');
      clearTimeout(t._t);
      t._t = setTimeout(function () { t.classList.remove('show'); }, 2500);
    }
    function showError(m) {
      var el = $('errorMsg');
      if (m) { el.textContent = m; el.classList.add('show'); }
      else { el.classList.remove('show'); el.textContent = ''; }
    }

    // ── 生成 ──
    function handleGenerate() {
      showError('');
      var link = $('inputLink').value.trim();
      var addrs = splitList($('inputAddresses').value);
      var ports = splitList($('inputPorts').value);
      if (!link) { showError('请粘贴 vless 节点链接'); return; }
      if (!addrs.length) { showError('请填写至少一个优选地址'); return; }
      if (!ports.length) { showError('请填写至少一个端口号'); return; }
      try {
        var r = generate(link, addrs, ports);
        if (!r.count) { showError('未生成任何节点，请检查输入'); return; }
        $('outputBase64').value = r.base64;
        $('outputPlain').value = r.plainText;
        $('count').textContent = r.count;
        if (!$('showPlain').checked) $('plainSection').style.display = 'none';
        showToast('✅ 成功生成 ' + r.count + ' 个节点');
        var url = buildSubscriptionUrl();
        if (url) {
          _subUrl = url;
          $('subUrlDisplay').value = url;
          $('urlLen').textContent = url.length;
          $('subUrlSection').style.display = 'block';
        }
      } catch (e) { showError('❌ ' + e.message); }
    }

    function handleTogglePlain() {
      $('plainSection').style.display = $('showPlain').checked ? 'block' : 'none';
    }

    // ── 复制 / 下载 / 清空 ──
    function copyToClipboard(text, msg) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          function () { showToast(msg); },
          function () { fallbackCopy(text, msg); }
        );
      } else fallbackCopy(text, msg);
    }
    function fallbackCopy(text, msg) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast(msg);
    }
    function handleCopy() {
      var t = $('outputBase64').value;
      if (!t) { showToast('没有可复制的内容'); return; }
      copyToClipboard(t, '📋 已复制 base64 订阅链接');
    }
    function handleCopySubUrl() {
      if (!_subUrl) { showToast('请先生成节点'); return; }
      copyToClipboard(_subUrl, '🔗 已复制订阅地址');
    }
    function handleCopyPlain() {
      var t = $('outputPlain').value;
      if (!t) { showToast('没有可复制的内容'); return; }
      copyToClipboard(t, '📋 已复制明文链接');
    }
    function handleDownload() {
      var t = $('outputBase64').value;
      if (!t) { showToast('没有可下载的内容'); return; }
      var blob = new Blob([t], { type: 'text/plain;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'preferred_nodes.txt';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('💾 文件已下载');
    }
    function handleClear() {
      $('inputLink').value = '';
      $('inputAddresses').value = '';
      $('inputPorts').value = '';
      $('outputBase64').value = '';
      $('outputPlain').value = '';
      $('count').textContent = '0';
      $('showPlain').checked = false;
      $('plainSection').style.display = 'none';
      $('subUrlSection').style.display = 'none';
      _subUrl = '';
      showError('');
      showToast('🗑️ 已清空');
    }

    // ── 构建订阅地址 URL（指向 index.html 自身，~ 分隔符不编码，缩短 URL）──
    function buildSubscriptionUrl() {
      var link = $('inputLink').value.trim();
      if (!link) return '';
      var addrs = $('inputAddresses').value.trim();
      var ports = $('inputPorts').value.trim();
      if (!addrs || !ports) return '';
      var p = extractParams(link);
      var parts = [];
      var add = function (k, v) { if (v) parts.push(k + '=' + encodeURIComponent(v)); };
      add('u', p.u);
      add('s', p.s || p.h);
      if (p.h && p.h !== p.s) add('h', p.h);
      if (p.p && p.p !== '/') add('p', p.p);
      if (p.f && p.f !== 'chrome') add('f', p.f);
      if (p.n) add('n', p.n);
      if (p.sec && p.sec !== 'tls') add('sec', p.sec);
      if (p.ty && p.ty !== 'ws') add('ty', p.ty);
      add('i', addrs.replace(/[,\s]+/g, '~'));
      add('t', ports.replace(/[,\s]+/g, '~'));
      return window.location.origin + window.location.pathname + '?' + parts.join('&');
    }

    // ── 构建界面并绑定事件 ──
    function buildUI() {
      var style = document.createElement('style');
      style.textContent = UI_CSS;
      document.head.appendChild(style);
      document.body.innerHTML = UI_HTML;

      $('generateBtn').addEventListener('click', handleGenerate);
      $('showPlain').addEventListener('change', handleTogglePlain);
      $('copyBtn').addEventListener('click', handleCopy);
      $('copySubBtn').addEventListener('click', handleCopySubUrl);
      $('copyPlainBtn').addEventListener('click', handleCopyPlain);
      $('downloadBtn').addEventListener('click', handleDownload);
      $('clearBtn').addEventListener('click', handleClear);
      document.addEventListener('keydown', function (e) {
        if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); handleGenerate(); }
      });

      // 预填 URL 参数（部分参数时进入正常模式并回填输入框）
      var p = readUrlParams();
      if (p) {
        if (p.link) $('inputLink').value = p.link;
        if (p.addresses) $('inputAddresses').value = p.addresses;
        if (p.ports) $('inputPorts').value = p.ports;
      }
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', buildUI);
    } else {
      buildUI();
    }
  })();
}
