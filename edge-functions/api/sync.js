// Edge Functions: /api/sync
// 从 cdnjs 拉取指定库文件，若自有 CDN 已存在则直接返回；否则上传到腾讯云 COS。
// 依赖：Web Crypto、fetch（Edge 运行时内置）。

const cdnJsBase = 'https://cdnjs.cloudflare.com/ajax/libs';

function guessContentTypeByKey(key) {
  const lower = key.toLowerCase();
  if (lower.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (lower.endsWith('.mjs')) return 'application/javascript; charset=utf-8';
  if (lower.endsWith('.cjs')) return 'application/javascript; charset=utf-8';
  if (lower.endsWith('.css')) return 'text/css; charset=utf-8';
  if (lower.endsWith('.json')) return 'application/json; charset=utf-8';
  if (lower.endsWith('.map')) return 'application/octet-stream';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.woff')) return 'font/woff';
  if (lower.endsWith('.woff2')) return 'font/woff2';
  return 'application/octet-stream';
}

function buildSelfCdnBase(env) {
  const base = (env.COS_CUSTOM_DOMAIN || '').replace(/\/$/, '');
  const folder = env.COS_LIB_FOLDER ? `/${env.COS_LIB_FOLDER.replace(/^\//, '').replace(/\/$/, '')}` : '';
  return `${base}${folder}`;
}

function selfCdnURL(env, name, version, key) {
  return `${buildSelfCdnBase(env)}/${name}/${version}/${key}`;
}

async function sha1Hex(input) {
  const enc = new TextEncoder();
  const data = typeof input === 'string' ? enc.encode(input) : input;
  const buf = await crypto.subtle.digest('SHA-1', data);
  const bytes = new Uint8Array(buf);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha1Hex(key, message) {
  const enc = new TextEncoder();
  const rawKey = typeof key === 'string' ? enc.encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey('raw', rawKey, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  const bytes = new Uint8Array(sig);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function normalizeHeaders(headers) {
  // 仅签名必要的头：host、content-type（小写）
  const map = new Map();
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || v === null) continue;
    const lk = k.toLowerCase();
    const lv = String(v).trim();
    if (lk === 'host' || lk === 'content-type') {
      map.set(lk, lv);
    }
  }
  return map;
}

async function buildCOSAuth({ secretId, secretKey, method, host, pathname, headers = {}, params = {} }) {
  // COS V5 简单签名（XML API），参考：q-sign-* 参数
  const now = Math.floor(Date.now() / 1000);
  const expire = now + 600; // 10 分钟
  const signTime = `${now};${expire}`;
  const keyTime = signTime;
  const signKey = await hmacSha1Hex(secretKey, keyTime);

  const urlParamList = Object.keys(params).map(k => k.toLowerCase()).sort().join(';');
  const headerMap = normalizeHeaders(headers);
  const headerKeysSorted = Array.from(headerMap.keys()).sort();
  const headerList = headerKeysSorted.join(';');

  const httpString = [
    method.toLowerCase(),
    pathname,
    // query string: k=v 按 key 排序并 URL 编码（此处无查询参数，留空即可）
    '',
    // headers: k=v 用换行连接，按 key 排序
    headerKeysSorted.map(k => `${k}=${encodeURIComponent(headerMap.get(k))}`).join('&')
  ].join('\n') + '\n';

  const httpStringSha1 = await sha1Hex(httpString);
  const stringToSign = ['sha1', signTime, httpStringSha1].join('\n') + '\n';
  const signature = await hmacSha1Hex(signKey, stringToSign);

  const authorization = `q-sign-algorithm=sha1&q-ak=${encodeURIComponent(secretId)}&q-sign-time=${signTime}&q-key-time=${keyTime}&q-header-list=${headerList}&q-url-param-list=${urlParamList}&q-signature=${signature}`;
  return authorization;
}

export async function onRequest(context) {
  const { request, env } = context;

  // CORS 与方法校验
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400'
      }
    });
  }
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ code: 405, msg: 'Method Not Allowed' }), {
      status: 405,
      headers: { 'content-type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
    });
  }

  const { COS_BUCKET_NAME, COS_REGION, COS_SECRET_ID, COS_SECRET_KEY, COS_CUSTOM_DOMAIN, COS_LIB_FOLDER } = env;
  if (!COS_BUCKET_NAME || !COS_REGION || !COS_SECRET_ID || !COS_SECRET_KEY || !COS_CUSTOM_DOMAIN) {
    return new Response(JSON.stringify({ code: 500, msg: '缺少 COS 配置环境变量' }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
    });
  }

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return new Response(JSON.stringify({ code: 400, msg: '无效的 JSON 请求体' }), {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
    });
  }

  const { name, version, key } = body || {};
  if (!name || !version || !key) {
    return new Response(JSON.stringify({ code: 400, msg: '参数错误' }), {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
    });
  }

  const selfFileURL = selfCdnURL(env, name, version, key);

  // 1) HEAD 检查自有 CDN 是否已存在
  try {
    const existResp = await fetch(selfFileURL, { method: 'HEAD' });
    if (existResp.ok) {
      const etag = existResp.headers.get('etag') || '';
      const hash = etag.replace(/"/g, '').split('.')[0] || undefined;
      return new Response(JSON.stringify({ code: 200, data: { hash, key: `${name}/${version}/${key}` }, msg: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
      });
    }
  } catch (e) {
    // 非 404 情况记录但不中断
  }

  // 2) 从 cdnjs 拉取
  const sourceUrl = `${cdnJsBase}/${encodeURIComponent(name)}/${encodeURIComponent(version)}/${key}`;
  const source = await fetch(sourceUrl, { method: 'GET' });
  if (!source.ok || !source.body) {
    return new Response(JSON.stringify({ code: 500, msg: `下载错误: ${source.status}` }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
    });
  }

  // 3) 上传到 COS
  const uploadKey = `${name}/${version}/${key}`;
  const cosHost = `${COS_BUCKET_NAME}.cos.${COS_REGION}.myqcloud.com`;
  const pathname = `/${uploadKey}`;
  const contentType = source.headers.get('content-type') || guessContentTypeByKey(key);

  const headersToSign = {
    Host: cosHost,
    'Content-Type': contentType
  };

  const authorization = await buildCOSAuth({
    secretId: COS_SECRET_ID,
    secretKey: COS_SECRET_KEY,
    method: 'PUT',
    host: cosHost,
    pathname,
    headers: headersToSign,
    params: {}
  });

  const putResp = await fetch(`https://${cosHost}${pathname}`, {
    method: 'PUT',
    headers: {
      'Authorization': authorization,
      'Host': cosHost,
      'Content-Type': contentType,
      'Content-Disposition': 'inline'
    },
    body: source.body
  });

  if (!putResp.ok) {
    const text = await putResp.text().catch(() => '');
    return new Response(JSON.stringify({ code: 500, msg: '上传错误', detail: text || putResp.statusText }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
    });
  }

  return new Response(JSON.stringify({ code: 200, msg: 'ok', data: { key: uploadKey } }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
  });
}


