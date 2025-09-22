// Edge Functions: /api/libraries
// 代理 cdnjs libraries API，支持 GET/POST(JSON) 与 OPTIONS，含 CORS。

export async function onRequest(context) {
  const { request } = context;

  // CORS headers
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  let name;
  let version;

  try {
    if (request.method === 'GET') {
      const url = new URL(request.url);
      name = url.searchParams.get('name');
      version = url.searchParams.get('version');
    } else if (request.method === 'POST') {
      const contentType = request.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        return new Response(JSON.stringify({ error: 'Unsupported POST content type' }), {
          status: 400,
          headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders }
        });
      }
      const body = await request.json();
      name = body?.name;
      version = body?.version;
    } else {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders }
      });
    }
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || 'Invalid request' }), {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders }
    });
  }

  if (!name) {
    return new Response(JSON.stringify({ error: 'Missing library name' }), {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders }
    });
  }

  const versionPath = version ? `/${encodeURIComponent(version)}` : '';
  const url = `https://api.cdnjs.com/libraries/${encodeURIComponent(name)}${versionPath}`;

  try {
    const resp = await fetch(url, { method: 'GET' });
    const data = await resp.json();
    return new Response(JSON.stringify(data), {
      status: resp.status,
      headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err?.message || 'Fetch error' }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders }
    });
  }
}


