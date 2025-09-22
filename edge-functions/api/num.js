// Edge Functions handler for /api/num
// Implements Tencent Cloud TC3-HMAC-SHA256 signing with Web Crypto and calls
// DescribeTopL7AnalysisData via fetch at Edge.

function toIso8601WithoutMilliseconds(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function hmacSha256Hex(key, message) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    typeof key === 'string' ? enc.encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  const bytes = new Uint8Array(sig);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256(key, message) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    typeof key === 'string' ? enc.encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  return new Uint8Array(sig);
}

async function getSignature(secretKey, date, service, stringToSign) {
  const kDate = await hmacSha256(`TC3${secretKey}`, date);
  const kService = await hmacSha256(kDate, service);
  const kSigning = await hmacSha256(kService, 'tc3_request');
  const signature = await hmacSha256Hex(kSigning, stringToSign);
  return signature;
}

function sha256Hex(input) {
  const enc = new TextEncoder();
  return crypto.subtle.digest('SHA-256', enc.encode(input)).then((buf) => {
    const bytes = new Uint8Array(buf);
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  });
}

export async function onRequest(context) {
  const { request, env } = context;

  // CORS
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    });
  }

  const url = new URL(request.url);
  const act = url.searchParams.get('act');

  const metricMap = {
    request: 'l7Flow_request_url',
    flow: 'l7Flow_outFlux_url'
  };
  const metricName = metricMap[act] || 'l7Flow_request_url';

  const endDate = new Date();
  const endTime = toIso8601WithoutMilliseconds(endDate);
  const startDate = new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);
  const startTime = toIso8601WithoutMilliseconds(startDate);

  const payload = {
    StartTime: startTime,
    EndTime: endTime,
    MetricName: metricName,
    Limit: 101,
    Filters: [
      { Key: 'domain', Operator: 'equals', Value: ['cdnjs.znnu.com'] },
      { Key: 'statusCode', Operator: 'equals', Value: ['200'] },
      { Key: 'url', Operator: 'notInclude', Value: ['/pages'] }
    ]
  };

  const service = 'teo';
  const host = 'teo.tencentcloudapi.com';
  const action = 'DescribeTopL7AnalysisData';
  const version = '2022-09-01';
  const algorithm = 'TC3-HMAC-SHA256';

  const now = new Date();
  const timestamp = Math.floor(now.getTime() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);

  const httpRequestMethod = 'POST';
  const canonicalUri = '/';
  const canonicalQueryString = '';
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\n`;
  const signedHeaders = 'content-type;host';
  const payloadJson = JSON.stringify(payload);
  const hashedRequestPayload = await sha256Hex(payloadJson);
  const canonicalRequest = `${httpRequestMethod}\n${canonicalUri}\n${canonicalQueryString}\n${canonicalHeaders}\n${signedHeaders}\n${hashedRequestPayload}`;

  const credentialScope = `${date}/${service}/tc3_request`;
  const hashedCanonicalRequest = await sha256Hex(canonicalRequest);
  const stringToSign = `${algorithm}\n${timestamp}\n${credentialScope}\n${hashedCanonicalRequest}`;

  const secretId = env.TENCENTCLOUD_SECRET_ID;
  const secretKey = env.TENCENTCLOUD_SECRET_KEY;
  if (!secretId || !secretKey) {
    return new Response(JSON.stringify({ error: 'Missing Tencent Cloud credentials' }), {
      status: 500,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }

  const signature = await getSignature(secretKey, date, service, stringToSign);
  const authorization = `${algorithm} Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  try {
    const resp = await fetch(`https://${host}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'host': host,
        'x-tc-action': action,
        'x-tc-timestamp': String(timestamp),
        'x-tc-version': version,
        'authorization': authorization
      },
      body: payloadJson
    });

    const json = await resp.json();

    // 错误透传
    if (!resp.ok || json?.Response?.Error) {
      return new Response(JSON.stringify({ error: 'API 调用失败', detail: json?.Response?.Error || json }), {
        status: 500,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    const data = json?.Response;
    if (data?.Data && Array.isArray(data.Data)) {
      data.Data = data.Data.map((item) => {
        if (Object.prototype.hasOwnProperty.call(item, 'TypeKey')) delete item.TypeKey;
        if (Array.isArray(item.DetailData)) item.DetailData = item.DetailData.filter((d) => d.Key !== '/');
        return item;
      });
    }

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'API 调用异常', detail: err?.message || String(err) }), {
      status: 500,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
}


