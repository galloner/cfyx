// Cloudflare Pages Functions - /sub 订阅端点
// 部署在 functions/sub.js，Cloudflare 在边缘服务器上运行此代码
// v2rayN 访问 /sub?u=...&i=...&t=... → 服务器直接返回 text/plain base64
// 不需要浏览器执行 JS，不需要 Service Worker

export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  const sp = url.searchParams;

  const u = sp.get('u'), i = sp.get('i'), t = sp.get('t');
  if (!u || !i || !t) {
    return new Response('Missing parameters. Usage: /sub?u=UUID&s=SNI&i=IPs&t=ports', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }

  const s = sp.get('s'), h = sp.get('h'), p = sp.get('p'), f = sp.get('f'), n = sp.get('n');
  const sec = sp.get('sec'), ty = sp.get('ty');

  // 从参数重建 vless 链接
  const sni = s || h || '';
  const host = h || s || '';
  const path = p || '/';
  const fp = f || 'chrome';
  const security = sec || 'tls';
  const type = ty || 'ws';
  const name = n || '';
  const link = 'vless://' + u + '@localhost:443?encryption=none&security=' + security +
    '&sni=' + sni + '&fp=' + fp + '&type=' + type + '&host=' + host +
    '&path=' + encodeURIComponent(path) + (name ? '#' + name : '');

  // 拆分地址和端口列表
  const addrs = i.split(/[~,\s]+/).filter(Boolean);
  const ports = t.split(/[~,\s]+/).filter(Boolean);

  if (!addrs.length || !ports.length) {
    return new Response('Empty address or port list', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }

  // 解析原始链接
  const rest = link.slice('vless://'.length);
  const hashIdx = rest.indexOf('#');
  const beforeName = hashIdx >= 0 ? rest.slice(0, hashIdx) : rest;
  const origName = hashIdx >= 0 ? rest.slice(hashIdx + 1) : '';
  const qIdx = beforeName.indexOf('?');
  const beforeParams = qIdx >= 0 ? beforeName.slice(0, qIdx) : beforeName;
  const params = qIdx >= 0 ? beforeName.slice(qIdx) : '';
  const atIdx = beforeParams.indexOf('@');
  const uuid = beforeParams.slice(0, atIdx);

  // 笛卡尔积生成节点
  function generateName(orig, idx) {
    if (!orig) return 'node_' + (idx + 1);
    const m = orig.match(/^(.*)_(\d+)$/);
    return m ? m[1] + '_' + (idx + 1) : orig + '_' + (idx + 1);
  }

  let counter = 0;
  const items = [];
  for (const addr of addrs) {
    if (!addr.trim()) continue;
    for (const port of ports) {
      if (!port.trim()) continue;
      const a = addr.includes(':') ? '[' + addr + ']' : addr;
      const nm = generateName(origName, counter);
      const node = 'vless://' + uuid + '@' + a + ':' + port + params + (nm ? '#' + nm : '');
      items.push(node);
      counter++;
    }
  }

  // 整体 base64 编码
  const plainText = items.map(n => n + '\n').join('');
  const base64 = btoa(plainText);

  return new Response(base64, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache'
    }
  });
}
