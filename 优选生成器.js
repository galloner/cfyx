#!/usr/bin/env node
/**
 * 优选生成器 - Vless 节点批量优选工具
 *
 * 功能：
 *   根据一个 vless 节点链接 + 多个优选地址（IP/域名）+ 多个端口号，
 *   批量替换节点的 address:port 部分，生成 N × M 个优选节点，
 *   节点名自动递增编号，所有节点拼接后整体 base64 编码输出（单个连续字符串，可直接导入 v2rayN）。
 *
 * 用法 1（交互模式，默认）：
 *   node 优选生成器.js
 *
 * 用法 2（命令行参数）：
 *   node 优选生成器.js "vless://UUID@host:port?params#name" "443,8443" "addr1 addr2"
 *
 * 作为模块：
 *   const { generate } = require('./优选生成器');
 *   const result = generate(link, ['1.1.1.1', '2.2.2.2'], [443, 8443]);
 *   // result.base64    → 单个连续 base64 字符串（所有节点拼接后整体编码）
 *   // result.plainText → 所有明文 vless 链接（\r\n 分隔）
 *   // result.items     → [{ plain, index }, ...]
 *   // result.count     → 节点总数
 */

'use strict';

// ===========================================================================
// 核心函数
// ===========================================================================

/**
 * 规范化输入：接受明文 vless 链接或 base64 编码的 vless 链接
 * @param {string} link
 * @returns {string} 明文 vless 链接
 */
function normalizeInput(link) {
  if (typeof link !== 'string') throw new TypeError('link must be a string');
  const s = link.trim();
  if (!s) throw new Error('Empty input');
  if (s.startsWith('vless://')) return s;
  // 尝试 base64 解码
  try {
    const decoded = Buffer.from(s, 'base64').toString('utf-8').trim();
    if (decoded.startsWith('vless://')) return decoded;
  } catch (_) { /* ignore */ }
  throw new Error('Input is not a valid vless link (plain or base64)');
}

/**
 * 解析 vless 链接
 * 格式: vless://UUID@ADDRESS:PORT?PARAMS#NAME
 *
 * @param {string} link
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
  if (atIdx < 0) throw new Error('Invalid vless link: missing @');
  const uuid = beforeParams.slice(0, atIdx);
  const addrPort = beforeParams.slice(atIdx + 1);

  // 4. 分离 address 与 port（支持 IPv6 [addr]:port）
  let address, port;
  if (addrPort.startsWith('[')) {
    const closeIdx = addrPort.indexOf(']');
    if (closeIdx < 0) throw new Error('Invalid IPv6 address (missing ])');
    address = addrPort.slice(1, closeIdx);
    port = addrPort.slice(closeIdx + 1).replace(/^:/, '');
  } else {
    const colonIdx = addrPort.lastIndexOf(':');
    if (colonIdx < 0) throw new Error('Invalid address:port (missing :)');
    address = addrPort.slice(0, colonIdx);
    port = addrPort.slice(colonIdx + 1);
  }

  if (!uuid) throw new Error('Empty UUID');
  if (!address) throw new Error('Empty address');
  if (!port) throw new Error('Empty port');

  return { uuid, address, port, params, name };
}

/**
 * 构建新的 vless 链接（替换 address 和 port）
 * 保持 UUID、参数（sni/host/path 等）和 name 不变
 *
 * @param {string} originalLink
 * @param {string} newAddress
 * @param {string|number} newPort
 * @returns {string}
 */
/**
 * 构建新的 vless 链接（替换 address 和 port，自动递增节点名）
 * 保持 UUID、参数（sni/host/path 等）不变
 *
 * @param {string} originalLink
 * @param {string} newAddress
 * @param {string|number} newPort
 * @param {number} nameIndex 节点序号（从 0 开始）
 * @returns {string}
 */
function buildVless(originalLink, newAddress, newPort, nameIndex) {
  const p = parseVless(originalLink);
  newAddress = String(newAddress).trim();
  newPort = String(newPort).trim();
  if (!newAddress) throw new Error('Empty address');
  if (!newPort) throw new Error('Empty port');
  const addr = newAddress.includes(':') ? `[${newAddress}]` : newAddress;
  const name = generateName(p.name, nameIndex);
  const namePart = name ? `#${name}` : '';
  return `vless://${p.uuid}@${addr}:${newPort}${p.params}${namePart}`;
}

/**
 * 根据索引生成递增节点名
 * 规则：
 *   - 原名为空 → node_1, node_2, ...
 *   - 原名以 _数字 结尾（如 snippet_1）→ snippet_1, snippet_2, snippet_3, ...
 *   - 原名不以 _数字 结尾（如 My Node）→ My Node_1, My Node_2, ...
 *
 * @param {string} originalName
 * @param {number} index 从 0 开始的索引
 * @returns {string}
 */
function generateName(originalName, index) {
  if (!originalName) return `node_${index + 1}`;
  const match = originalName.match(/^(.*)_(\d+)$/);
  if (match) {
    return `${match[1]}_${index + 1}`;
  }
  return `${originalName}_${index + 1}`;
}

/**
 * Base64 编码（整体编码，不追加换行符）
 * @param {string} text
 * @returns {string}
 */
function encodeBase64(text) {
  return Buffer.from(text, 'utf-8').toString('base64');
}

/**
 * Base64 解码（与 encodeBase64 对应）
 * @param {string} encoded
 * @returns {string}
 */
function decodeBase64(encoded) {
  return Buffer.from(encoded, 'base64').toString('utf-8');
}

/**
 * 生成所有优选节点
 *
 * 对每个优选地址 × 每个端口 进行笛卡尔积组合，
 * 替换原节点的 address:port 部分，base64 编码后返回。
 *
 * @param {string} originalLink 原始 vless 链接
 * @param {string[]} preferredAddresses 优选地址列表（IP 或域名）
 * @param {(string|number)[]} ports 端口列表
 * @returns {string[]} base64 编码后的节点列表
 */
/**
 * 生成所有优选节点
 *
 * 对每个优选地址 × 每个端口 进行笛卡尔积组合，
 * 替换原节点的 address:port 部分，节点名自动递增编号。
 * 所有明文链接拼接（每个结尾 \r\n）后整体 base64 编码，返回单个连续字符串。
 *
 * @param {string} originalLink 原始 vless 链接
 * @param {string[]} preferredAddresses 优选地址列表（IP 或域名）
 * @param {(string|number)[]} ports 端口列表
 * @returns {{base64:string, plainText:string, items:object[], count:number}}
 */
function generate(originalLink, preferredAddresses, ports) {
  if (!Array.isArray(preferredAddresses) || preferredAddresses.length === 0) {
    throw new Error('preferredAddresses must be a non-empty array');
  }
  if (!Array.isArray(ports) || ports.length === 0) {
    throw new Error('ports must be a non-empty array');
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

  // 所有明文链接拼接（每个结尾 \r\n），整体 base64 编码
  const plainText = items.map(item => item.plain + '\r\n').join('');
  const base64 = encodeBase64(plainText);

  return {
    base64: base64,
    plainText: plainText,
    items: items,
    count: items.length
  };
}

module.exports = {
  normalizeInput,
  parseVless,
  buildVless,
  generateName,
  encodeBase64,
  decodeBase64,
  generate,
};

// ===========================================================================
// CLI
// ===========================================================================

/**
 * 拆分列表字符串：支持逗号、空格、制表符分隔
 * @param {string} raw
 * @returns {string[]}
 */
function splitList(raw) {
  return String(raw).split(/[,\s]+/).filter(Boolean);
}

/**
 * 交互模式：通过 readline 提示用户逐步输入
 */
function runInteractive() {
  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
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

/**
 * 命令行参数模式
 * 用法: node 优选生成器.js <vless链接> <端口列表> <优选地址列表>
 */
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

  if (ports.length === 0) {
    console.error('错误: 端口列表为空');
    process.exit(1);
  }
  if (addrs.length === 0) {
    console.error('错误: 优选地址列表为空');
    process.exit(1);
  }

  const result = generate(link, addrs, ports);

  console.log(`=== 生成结果（共 ${result.count} 个节点）===`);
  console.log('base64（单个连续字符串，可直接导入 v2rayN）:');
  console.log(result.base64);
  console.log('');
  console.log('明文 vless 链接:');
  console.log(result.plainText);
}

// Main
if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.length >= 3) {
    runFromArgs(argv);
  } else {
    runInteractive();
  }
}
