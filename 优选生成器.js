#!/usr/bin/env node
/**
 * 优选生成器 - Vless 节点批量优选工具（单文件，浏览器 + Node 双环境）
 *
 * 功能：
 *   根据一个或多个 vless 节点链接 + 多个优选地址（IP/域名）+ 多个端口号，
 *   批量替换节点的 address:port 部分，生成 N × M × P 个优选节点，
 *   节点名自动编号（CF01-1, CF01-2, CF02-1 ...），所有节点拼接后整体 base64 编码输出。
 *
 * ── 浏览器（index.html 引用本文件）──
 *   访问 index.html → 构建前端界面
 *
 * ── Node.js CLI ──
 *   用法 1（交互模式，默认）：
 *     node 优选生成器.js
 *   用法 2（命令行参数）：
 *     node 优选生成器.js "vless://UUID@host:port?params#name" "443,8443" "addr1 addr2"
 *   作为模块：
 *     const { generate, generateAll, parseAddresses } = require('./优选生成器');
 *     const result = generateAll(links, addresses, ports);
 */

'use strict';

// ===========================================================================
// 核心函数（浏览器 / Node 通用）
// ===========================================================================

function b64Encode(s) {
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    return Buffer.from(String(s), 'utf-8').toString('base64');
  }
  return btoa(unescape(encodeURIComponent(String(s))));
}

function b64Decode(s) {
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    return Buffer.from(String(s), 'base64').toString('utf-8');
  }
  return decodeURIComponent(escape(atob(String(s))));
}

function normalizeInput(link) {
  if (typeof link !== 'string') throw new Error('输入必须是字符串');
  var s = link.trim();
  if (!s) throw new Error('输入为空');
  if (s.indexOf('vless://') === 0) return s;
  try {
    var d = b64Decode(s).trim();
    if (d.indexOf('vless://') === 0) return d;
  } catch (_) {}
  throw new Error('不是有效的 vless 链接（既不是明文也不是 base64）');
}

/**
 * 解析 vless 链接
 * 格式: vless://UUID@ADDRESS:PORT?PARAMS#NAME
 */
function parseVless(link) {
  var s = normalizeInput(link);
  var rest = s.slice('vless://'.length);
  var hashIdx = rest.indexOf('#');
  var beforeName = hashIdx >= 0 ? rest.slice(0, hashIdx) : rest;
  var name = hashIdx >= 0 ? rest.slice(hashIdx + 1) : '';
  var qIdx = beforeName.indexOf('?');
  var beforeParams = qIdx >= 0 ? beforeName.slice(0, qIdx) : beforeName;
  var params = qIdx >= 0 ? beforeName.slice(qIdx) : '';
  var atIdx = beforeParams.indexOf('@');
  if (atIdx < 0) throw new Error('vless 链接格式错误：缺少 @');
  var uuid = beforeParams.slice(0, atIdx);
  var addrPort = beforeParams.slice(atIdx + 1);
  var address, port;
  if (addrPort.charAt(0) === '[') {
    var closeIdx = addrPort.indexOf(']');
    if (closeIdx < 0) throw new Error('IPv6 地址格式错误（缺少 ]）');
    address = addrPort.slice(1, closeIdx);
    port = addrPort.slice(closeIdx + 1).replace(/^:/, '');
  } else {
    var colonIdx = addrPort.lastIndexOf(':');
    if (colonIdx < 0) throw new Error('地址格式错误：缺少端口分隔符 :');
    address = addrPort.slice(0, colonIdx);
    port = addrPort.slice(colonIdx + 1);
  }
  if (!uuid) throw new Error('UUID 为空');
  if (!address) throw new Error('地址为空');
  if (!port) throw new Error('端口为空');
  return { uuid: uuid, address: address, port: port, params: params, name: name };
}

/**
 * 构建新的 vless 链接（替换 address:port，指定节点名）
 */
function buildVless(originalLink, newAddress, newPort, nodeName) {
  var p = parseVless(originalLink);
  newAddress = String(newAddress).trim();
  newPort = String(newPort).trim();
  if (!newAddress) throw new Error('地址为空');
  if (!newPort) throw new Error('端口为空');
  var addr = newAddress.indexOf(':') >= 0 ? '[' + newAddress + ']' : newAddress;
  var namePart = nodeName ? '#' + nodeName : '';
  return 'vless://' + p.uuid + '@' + addr + ':' + newPort + p.params + namePart;
}

/**
 * 根据索引生成递增节点名（兼容旧版，供外部调用）
 */
function generateName(originalName, index) {
  if (!originalName) return 'node_' + (index + 1);
  var m = originalName.match(/^(.*)_(\d+)$/);
  if (m) return m[1] + '_' + (index + 1);
  return originalName + '_' + (index + 1);
}

// ===========================================================================
// 地址解析（智能过滤：从杂乱文本中提取 IP/域名 + 可选 #名称）
// ===========================================================================

/**
 * 从杂乱文本中提取第一个有效的 IP 或域名
 * 处理格式: "IP:port", "domain:port", "IP,xxx,yyy", "domain,xxx,yyy" 等
 */
function extractAddress(text) {
  text = String(text).trim();
  if (!text) return null;
  // IPv4 (优先匹配)
  var m = text.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
  if (m) return m[1];
  // 域名 (至少两段，首段以字母开头，排除纯数字如 0.00 / 66.57)
  m = text.match(/[a-zA-Z][a-zA-Z0-9\-]*(?:\.[a-zA-Z0-9\-]+)*\.[a-zA-Z]{2,}/);
  if (m) return m[0];
  return null;
}

/**
 * 解析优选地址文本（每行一个地址，自动过滤无关字符）
 * 格式支持:
 *   162.159.197.1:443#官方入口 | ZeroTrust
 *   www.decathlon.com
 *   104.24.2.167,4,4,0.00,66.57,16.36,HKG
 *   104.24.2.167,4,4,0.00,66.57,104.31.16.240#优选节点
 * 返回: [{ address: string, name: string }, ...]
 */
function parseAddresses(raw) {
  var lines = String(raw).split(/\n/);
  var results = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    var name = '';
    var addrPart = line;
    var hashIdx = line.indexOf('#');
    if (hashIdx >= 0) {
      addrPart = line.slice(0, hashIdx).trim();
      name = line.slice(hashIdx + 1).trim();
    }
    // 按逗号分割，找第一个有效地址
    var elements = addrPart.split(',');
    var address = null;
    for (var j = 0; j < elements.length; j++) {
      var elem = elements[j].trim();
      if (!elem) continue;
      var addr = extractAddress(elem);
      if (addr) { address = addr; break; }
    }
    if (address) {
      results.push({ address: address, name: name });
    }
  }
  return results;
}

// ===========================================================================
// 多节点生成（核心生成函数）
// ===========================================================================

/**
 * 根据多个原始节点 + 多个优选地址 + 多个端口，批量生成所有优选节点
 * 命名规则: CF{节点序号}-{地址名称或计数器}
 * @param {string[]} originalLinks  - 原始 vless 链接数组（支持多条）
 * @param {Array<{address:string,name:string}>} addresses - 优选地址数组
 * @param {string[]} ports          - 端口号数组
 * @returns {{base64:string, plainText:string, items:Array, count:number}}
 */
function generateAll(originalLinks, addresses, ports) {
  if (!originalLinks || !originalLinks.length) throw new Error('原始节点列表为空');
  if (!addresses || !addresses.length) throw new Error('优选地址列表为空');
  if (!ports || !ports.length) throw new Error('端口列表为空');

  var allItems = [];

  for (var ni = 0; ni < originalLinks.length; ni++) {
    var nodeIdx = ni + 1;
    var nodePrefix = 'CF' + (nodeIdx < 10 ? '0' : '') + nodeIdx;
    var counter = 0;

    for (var ai = 0; ai < addresses.length; ai++) {
      var addr = addresses[ai];
      for (var pi = 0; pi < ports.length; pi++) {
        counter++;
        var nodeName;
        if (addr.name) {
          nodeName = nodePrefix + '-' + addr.name;
          if (ports.length > 1) nodeName += '-' + (pi + 1);
        } else {
          nodeName = nodePrefix + '-' + counter;
        }
        var newLink = buildVless(originalLinks[ni], addr.address, ports[pi], nodeName);
        allItems.push({ plain: newLink, index: counter, nodeIdx: nodeIdx });
      }
    }
  }

  var plainText = allItems.map(function(item) { return item.plain + '\r\n'; }).join('');
  return {
    base64: b64Encode(plainText),
    plainText: plainText,
    items: allItems,
    count: allItems.length
  };
}

/**
 * 兼容旧版 generate（单节点 + 字符串地址列表）
 */
function generate(originalLink, preferredAddresses, ports) {
  var links = [originalLink];
  var addrs = [];
  for (var i = 0; i < preferredAddresses.length; i++) {
    var parsed = parseAddresses(String(preferredAddresses[i]));
    if (parsed.length) addrs.push(parsed[0]);
  }
  return generateAll(links, addrs, ports);
}

// ===========================================================================
// 工具函数
// ===========================================================================

function splitList(raw) {
  return String(raw).split(/[~,\s]+/).filter(Boolean);
}

/**
 * 从文本中解析多条 vless 链接（每行一条，支持明文和 base64）
 */
function parseLinks(raw) {
  var lines = String(raw).split(/\n/);
  var links = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    try {
      links.push(normalizeInput(line));
    } catch (e) {
      // 跳过无效行
    }
  }
  return links;
}

/**
 * 根据参数构建 vless 链接（用于"填写参数"模式）
 */
function buildLinkFromParams(params) {
  var uuid = params.uuid || '';
  var host = params.host || '';
  if (!uuid || !host) throw new Error('UUID 和 HOST 不能为空');
  var path = params.path || '/';
  var sec = params.security || 'tls';
  var type = params.type || 'ws';
  var fp = params.fp || 'chrome';
  var name = params.name || '';
  return 'vless://' + uuid + '@localhost:443?encryption=none&security=' + sec +
    '&sni=' + host + '&fp=' + fp + '&type=' + type +
    '&host=' + host + '&path=' + encodeURIComponent(path) +
    (name ? '#' + name : '');
}

// ===========================================================================
// Node.js：导出模块 + CLI
// ===========================================================================

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    b64Encode,
    b64Decode,
    normalizeInput,
    parseVless,
    buildVless,
    generateName,
    parseAddresses,
    extractAddress,
    generateAll,
    generate,
    splitList,
    parseLinks,
    buildLinkFromParams,
  };
}

if (typeof require !== 'undefined' && typeof require.main !== 'undefined' && require.main === module) {
  var argv = process.argv.slice(2);

  if (argv.length >= 3) {
    // CLI 参数模式
    var link = argv[0];
    var ports = splitList(argv[1]);
    var addrs = parseAddresses(argv.slice(2).join('\n'));
    if (!ports.length) { console.error('错误: 端口列表为空'); process.exit(1); }
    if (!addrs.length) { console.error('错误: 优选地址列表为空'); process.exit(1); }
    var result = generateAll([link], addrs, ports);
    console.log('=== 生成结果（共 ' + result.count + ' 个节点）===');
    console.log('base64:');
    console.log(result.base64);
    console.log('');
    console.log('明文 vless 链接:');
    console.log(result.plainText);
  } else {
    // 交互模式
    var readline = require('readline');
    var rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    var ask = function(q) { return new Promise(function(resolve) { rl.question(q, resolve); }); };

    (async function() {
      var closed = false;
      try {
        console.log('========================================');
        console.log('        优选生成器 - Vless 节点批量优选');
        console.log('========================================');
        console.log('（每行输入一条 vless 链接，空行结束）');
        console.log('');
        var lines = [];
        while (true) {
          var line = (await ask('> ')).trim();
          if (!line) break;
          lines.push(line);
        }
        closed = true;
        rl.close();
        if (!lines.length) { console.log('未输入任何节点'); process.exit(0); }
        var links = parseLinks(lines.join('\n'));
        if (!links.length) { console.error('错误: 无有效节点'); process.exit(1); }

        var portsRaw = (await ask('端口号（多个用逗号或空格分隔，如 443,8443）: ')).trim();
        var addrsRaw = (await ask('优选地址（每行一个，支持 #名称 格式）: ')).trim();

        closed = true;
        rl.close();
        var ports = splitList(portsRaw);
        var addrs = parseAddresses(addrsRaw);
        if (!ports.length) throw new Error('端口列表为空');
        if (!addrs.length) throw new Error('优选地址列表为空');

        var result = generateAll(links, addrs, ports);
        console.log('');
        console.log('=== 生成结果（共 ' + result.count + ' 个节点）===');
        console.log('base64:');
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
}

// ===========================================================================
// 浏览器：前端界面（index.html 为空壳，所有 UI 由本文件构建）
// ===========================================================================

if (typeof window !== 'undefined') {
  (function () {
    'use strict';

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
      'textarea{width:100%;background:var(--bg-input);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:12px 14px;font-size:13px;font-family:"SF Mono","Cascadia Code",Consolas,monospace;resize:vertical;transition:border-color .2s,box-shadow .2s;outline:none;min-height:88px}' +
      'textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-glow)}' +
      'input[type=text],select{width:100%;background:var(--bg-input);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:10px 12px;font-size:13px;outline:none;transition:border-color .2s}' +
      'input[type=text]:focus,select:focus{border-color:var(--accent)}' +
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
      '.toggle-row{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-dim);margin:14px 0 4px}' +
      '.toggle-row input[type=checkbox]{width:16px;height:16px;accent-color:var(--accent);cursor:pointer}' +
      '.error-msg{color:var(--danger);font-size:13px;margin-top:10px;padding:10px 14px;background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.3);border-radius:8px;display:none}' +
      '.error-msg.show{display:block}' +
      'footer{text-align:center;color:var(--text-dim);font-size:12px;margin-top:32px;padding-top:18px;border-top:1px solid var(--border)}' +
      '.format-note{font-size:12px;color:var(--text-dim);margin-top:8px;padding:8px 12px;background:rgba(91,157,255,.08);border-left:3px solid var(--accent);border-radius:4px}' +
      '.format-note b{color:var(--accent)}' +
      /* 模式切换 */
      '.mode-toggle{display:flex;gap:0;margin-bottom:14px}' +
      '.mode-option{flex:1;text-align:center;padding:10px 16px;font-size:13px;font-weight:600;cursor:pointer;border:1px solid var(--border);color:var(--text-dim);transition:all .2s;user-select:none}' +
      '.mode-option:first-child{border-radius:8px 0 0 8px}' +
      '.mode-option:last-child{border-radius:0 8px 8px 0}' +
      '.mode-option.active{background:var(--accent);color:#fff;border-color:var(--accent)}' +
      '.mode-option:not(.active):hover{background:var(--bg-input)}' +
      '.mode-content{display:none}' +
      '.mode-content.active{display:block}' +
      /* 参数网格 */
      '.param-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}' +
      '.param-field{display:flex;flex-direction:column}' +
      '.param-field label{margin-bottom:4px}' +
      /* 端口复选框 */
      '.port-checks{display:flex;flex-wrap:wrap;gap:10px;margin-top:8px}' +
      '.port-check{display:flex;align-items:center;gap:6px;padding:8px 14px;background:var(--bg-input);border:1px solid var(--border);border-radius:8px;cursor:pointer;font-size:13px;transition:all .2s;user-select:none}' +
      '.port-check:hover{border-color:var(--accent)}' +
      '.port-check input{width:16px;height:16px;accent-color:var(--accent)}' +
      '.port-check.checked{border-color:var(--accent);background:rgba(91,157,255,.1)}' +
      /* 地址格式说明 */
      '.addr-format{font-size:12px;color:var(--text-dim);margin-top:10px;padding:10px 12px;background:rgba(91,157,255,.06);border:1px solid rgba(91,157,255,.15);border-radius:8px;line-height:1.8}' +
      '.addr-format b{color:var(--accent)}' +
      '.addr-format code{background:var(--bg-input);padding:2px 6px;border-radius:4px;font-size:11px}' +
      /* 节点计数 */
      '.node-list{font-size:12px;color:var(--text-dim);margin-top:8px;padding:8px 12px;background:var(--bg-input);border-radius:6px;max-height:120px;overflow-y:auto}' +
      '.node-list-item{display:flex;justify-content:space-between;gap:8px;padding:2px 0}' +
      '.node-list-item .idx{color:var(--accent);font-weight:600}' +
      '.node-list-item .nm{color:var(--text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '@media(max-width:600px){.param-grid{grid-template-columns:1fr}.port-checks{gap:6px}.port-check{padding:6px 10px;font-size:12px}}';

    // ── 界面 HTML ──
    var UI_HTML =
      '<div class="container">' +
      '<header>' +
      '<h1>⚡ 优选生成器</h1>' +
      '<p>Vless 节点批量优选 · 一键生成 base64 订阅</p>' +
      '</header>' +
      // Card 1: 原始节点
      '<div class="card">' +
      '<h2><span class="num">1</span> 原始节点</h2>' +
      '<div class="mode-toggle" id="modeToggle">' +
      '<span class="mode-option active" data-mode="paste">📋 粘贴原始节点</span>' +
      '<span class="mode-option" data-mode="params">⚙️ 填写参数</span>' +
      '</div>' +
      '<div id="pasteMode" class="mode-content active">' +
      '<label for="inputLinks">粘贴 vless 链接（支持多行，每行一个节点）</label>' +
      '<textarea id="inputLinks" placeholder="vless://xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx@your-host.com:443?encryption=none&#38;security=tls&#38;sni=your-host.com&#38;fp=chrome&#38;type=ws&#38;host=your-host.com&#38;path=/#MyNode"></textarea>' +
      '<div class="hint">支持直接粘贴 <code>vless://...</code> 明文链接，或 base64 编码链接（自动解码）。每行一个节点。</div>' +
      '</div>' +
      '<div id="paramsMode" class="mode-content">' +
      '<div class="param-grid">' +
      '<div class="param-field"><label>UUID *</label><input type="text" id="paramUUID" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"></div>' +
      '<div class="param-field"><label>HOST / SNI *</label><input type="text" id="paramHost" placeholder="your-host.com"></div>' +
      '<div class="param-field"><label>Path</label><input type="text" id="paramPath" placeholder="/" value="/"></div>' +
      '<div class="param-field"><label>名称</label><input type="text" id="paramName" placeholder="My Node"></div>' +
      '<div class="param-field"><label>安全</label><select id="paramSec"><option value="tls">TLS</option><option value="reality">Reality</option><option value="none">None</option></select></div>' +
      '<div class="param-field"><label>传输</label><select id="paramType"><option value="ws">WebSocket</option><option value="http">HTTP</option></select></div>' +
      '<div class="param-field"><label>指纹</label><select id="paramFP"><option value="chrome">Chrome</option><option value="firefox">Firefox</option><option value="safari">Safari</option><option value="ios">iOS</option><option value="android">Android</option><option value="random">Random</option></select></div>' +
      '<div class="param-field" style="opacity:0;pointer-events:none"><input type="text" disabled></div>' +
      '</div>' +
      '<div class="hint" style="margin-top:8px">* 为必填项。填写后自动生成 vless 链接用于优选。</div>' +
      '</div>' +
      '</div>' +
      // Card 2: 优选地址
      '<div class="card">' +
      '<h2><span class="num">2</span> 优选地址（IP / 域名）</h2>' +
      '<label for="inputAddresses">每行一个地址，支持 #名称 格式</label>' +
      '<textarea id="inputAddresses" placeholder="加载中..."></textarea>' +
      '<div class="addr-format">' +
      '<b>支持的格式：</b><br>' +
      '<code>162.159.197.1:443#官方入口 | ZeroTrust</code> — IP + 名称<br>' +
      '<code>www.decathlon.com:443#企业域名 | 迪卡侬</code> — 域名 + 名称<br>' +
      '<code>104.24.2.167,4,4,0.00,66.57,16.36,HKG</code> — 自动提取 IP<br>' +
      '<code>104.24.2.167,4,4,0.00,66.57,104.31.16.240#优选节点</code> — 多 IP 取第一个<br>' +
      '<br><b>规则：</b>每行识别一个地址，# 后为名称（写入节点名），无关字符自动过滤。' +
      '</div>' +
      '</div>' +
      // Card 3: 端口号
      '<div class="card">' +
      '<h2><span class="num">3</span> 端口号</h2>' +
      '<label>选择 Cloudflare 支持的端口（可多选）</label>' +
      '<div class="port-checks" id="portChecks">' +
      '<label class="port-check checked"><input type="checkbox" value="443" checked> 443</label>' +
      '<label class="port-check"><input type="checkbox" value="8443"> 8443</label>' +
      '<label class="port-check"><input type="checkbox" value="2053"> 2053</label>' +
      '<label class="port-check"><input type="checkbox" value="2083"> 2083</label>' +
      '<label class="port-check"><input type="checkbox" value="2087"> 2087</label>' +
      '<label class="port-check"><input type="checkbox" value="2096"> 2096</label>' +
      '</div>' +
      '</div>' +
      // 生成按钮
      '<div class="btn-group primary">' +
      '<button id="generateBtn">🚀 一键生成优选节点</button>' +
      '</div>' +
      // 结果
      '<div class="card">' +
      '<div class="output-toolbar">' +
      '<h2 style="margin:0"><span class="num">✓</span> 生成结果</h2>' +
      '<div class="stats">共 <span class="count" id="count">0</span> 个节点</div>' +
      '</div>' +
      '<div class="error-msg" id="errorMsg"></div>' +
      '<div class="format-note">base64 输出为<b>单个连续字符串</b>（所有节点拼接后整体编码），可直接复制导入 v2rayN。</div>' +
      '<div class="section-label" style="margin-top:14px"><span class="tag tag-b64">base64</span> 订阅数据（单个字符串，可直接导入）</div>' +
      '<div class="output-area"><textarea id="outputBase64" readonly placeholder="生成的 base64 将显示在此处..."></textarea></div>' +
      '<div class="toggle-row"><label><input type="checkbox" id="showPlain"> 显示明文 vless 链接</label></div>' +
      '<div id="plainSection" style="display:none">' +
      '<div class="section-label"><span class="tag tag-plain">plain</span> 明文 vless 链接（每行一个节点）</div>' +
      '<div class="output-area"><textarea id="outputPlain" readonly placeholder="明文 vless 链接将显示在此处..."></textarea></div>' +
      '</div>' +
      '<div id="nodeListSection" style="display:none">' +
      '<div class="section-label" style="margin-top:14px">📋 节点列表</div>' +
      '<div class="node-list" id="nodeList"></div>' +
      '</div>' +
      '<div class="btn-group" style="margin-top:14px">' +
      '<button class="secondary" id="copyBtn">📋 复制 base64</button>' +
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
    var currentMode = 'paste';

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

    // ── 预填默认地址（从 bestcf 获取，失败则用硬编码）──
    var DEFAULT_ADDRESSES = [
      '162.159.197.1:443#官方入口 | ZeroTrust',
      '162.159.198.1:443#官方入口 | MASQUE',
      'www.decathlon.com:443#企业域名 | 迪卡侬',
      'www.asda.com:443#企业域名 | 阿斯达',
      'serviceshub.samsclub.com:443#企业域名 | 山姆会员'
    ];

    function loadDefaultAddresses() {
      if (typeof fetch !== 'undefined') {
        fetch('https://bestcf.pages.dev/domain/mini.txt')
          .then(function (r) { return r.text(); })
          .then(function (text) {
            var lines = text.trim().split(/\n/).filter(Boolean).slice(0, 5);
            if (lines.length) $('inputAddresses').value = lines.join('\n');
          })
          .catch(function () {
            $('inputAddresses').value = DEFAULT_ADDRESSES.join('\n');
          });
      } else {
        $('inputAddresses').value = DEFAULT_ADDRESSES.join('\n');
      }
    }

    // ── 获取选中的端口 ──
    function getSelectedPorts() {
      var checks = document.querySelectorAll('#portChecks input[type=checkbox]:checked');
      var ports = [];
      for (var i = 0; i < checks.length; i++) ports.push(checks[i].value);
      return ports;
    }

    // ── 生成处理 ──
    function handleGenerate() {
      showError('');
      var links;
      if (currentMode === 'paste') {
        links = parseLinks($('inputLinks').value);
      } else {
        try {
          links = [buildLinkFromParams({
            uuid: $('paramUUID').value.trim(),
            host: $('paramHost').value.trim(),
            path: $('paramPath').value.trim() || '/',
            name: $('paramName').value.trim(),
            security: $('paramSec').value,
            type: $('paramType').value,
            fp: $('paramFP').value
          })];
        } catch (e) {
          showError(e.message);
          return;
        }
      }
      var addresses = parseAddresses($('inputAddresses').value);
      var ports = getSelectedPorts();

      if (!links.length) { showError('请提供至少一个原始节点'); return; }
      if (!addresses.length) { showError('请填写至少一个优选地址'); return; }
      if (!ports.length) { showError('请至少选择一个端口'); return; }

      try {
        var r = generateAll(links, addresses, ports);
        if (!r.count) { showError('未生成任何节点，请检查输入'); return; }
        $('outputBase64').value = r.base64;
        $('outputPlain').value = r.plainText;
        $('count').textContent = r.count;
        if (!$('showPlain').checked) $('plainSection').style.display = 'none';

        // 显示节点列表
        var nl = $('nodeList');
        nl.innerHTML = '';
        for (var i = 0; i < r.items.length; i++) {
          var it = r.items[i];
          var div = document.createElement('div');
          div.className = 'node-list-item';
          var idxSpan = document.createElement('span');
          idxSpan.className = 'idx';
          idxSpan.textContent = '#' + (i + 1);
          var nmSpan = document.createElement('span');
          nmSpan.className = 'nm';
          // Extract name from vless link (after #)
          var hashIdx2 = it.plain.lastIndexOf('#');
          var nm2 = hashIdx2 >= 0 ? it.plain.slice(hashIdx2 + 1) : '';
          nmSpan.textContent = nm2 || it.plain.slice(0, 60);
          div.appendChild(idxSpan);
          div.appendChild(nmSpan);
          nl.appendChild(div);
        }
        $('nodeListSection').style.display = 'block';

        showToast('✅ 成功生成 ' + r.count + ' 个节点');
      } catch (e) {
        showError('❌ ' + e.message);
      }
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
      copyToClipboard(t, '📋 已复制 base64 数据');
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
      if (currentMode === 'paste') $('inputLinks').value = '';
      $('paramUUID').value = '';
      $('paramHost').value = '';
      $('paramName').value = '';
      $('paramPath').value = '/';
      $('outputBase64').value = '';
      $('outputPlain').value = '';
      $('count').textContent = '0';
      $('showPlain').checked = false;
      $('plainSection').style.display = 'none';
      $('nodeListSection').style.display = 'none';
      showError('');
      showToast('🗑️ 已清空');
    }

    function handleTogglePlain() {
      $('plainSection').style.display = $('showPlain').checked ? 'block' : 'none';
    }

    // ── 模式切换 ──
    function handleModeSwitch(mode) {
      currentMode = mode;
      var opts = document.querySelectorAll('.mode-option');
      for (var i = 0; i < opts.length; i++) {
        opts[i].classList.toggle('active', opts[i].getAttribute('data-mode') === mode);
      }
      $('pasteMode').classList.toggle('active', mode === 'paste');
      $('paramsMode').classList.toggle('active', mode === 'params');
    }

    // ── 端口复选框样式 ──
    function updatePortStyles() {
      var checks = document.querySelectorAll('.port-check');
      for (var i = 0; i < checks.length; i++) {
        var input = checks[i].querySelector('input');
        checks[i].classList.toggle('checked', input.checked);
      }
    }

    // ── 构建界面并绑定事件 ──
    function buildUI() {
      var style = document.createElement('style');
      style.textContent = UI_CSS;
      document.head.appendChild(style);
      document.body.innerHTML = UI_HTML;

      // 预填默认地址
      loadDefaultAddresses();

      // 模式切换
      var modeOpts = document.querySelectorAll('.mode-option');
      for (var i = 0; i < modeOpts.length; i++) {
        (function (opt) {
          opt.addEventListener('click', function () {
            handleModeSwitch(opt.getAttribute('data-mode'));
          });
        })(modeOpts[i]);
      }

      // 端口复选框
      var portInputs = document.querySelectorAll('#portChecks input[type=checkbox]');
      for (var j = 0; j < portInputs.length; j++) {
        portInputs[j].addEventListener('change', updatePortStyles);
      }
      updatePortStyles();

      // 按钮
      $('generateBtn').addEventListener('click', handleGenerate);
      $('showPlain').addEventListener('change', handleTogglePlain);
      $('copyBtn').addEventListener('click', handleCopy);
      $('copyPlainBtn').addEventListener('click', handleCopyPlain);
      $('downloadBtn').addEventListener('click', handleDownload);
      $('clearBtn').addEventListener('click', handleClear);

      // Ctrl+Enter 快捷生成
      document.addEventListener('keydown', function (e) {
        if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); handleGenerate(); }
      });
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', buildUI);
    } else {
      buildUI();
    }
  })();
}