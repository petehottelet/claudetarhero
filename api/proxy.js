// Vercel serverless function: proxies third-party APIs so the browser never
// hits CORS walls.
//
//   /api/proxy?type=search&term=...  -> iTunes song search JSON
//   /api/proxy?type=audio&url=...    -> streams an iTunes .m4a preview

const ALLOWED_AUDIO_HOSTS = [
  'audio-ssl.itunes.apple.com',
  'itunes.apple.com',
];

function audioHostAllowed(host) {
  return ALLOWED_AUDIO_HOSTS.includes(host) || host.endsWith('.mzstatic.com');
}

export async function proxyRequest(query) {
  const type = query.get('type');

  if (type === 'search') {
    const term = (query.get('term') || '').slice(0, 200);
    if (!term) return { status: 400, json: { error: 'missing term' } };
    const url =
      'https://itunes.apple.com/search?media=music&entity=song&limit=30&term=' +
      encodeURIComponent(term);
    const r = await fetch(url, { headers: { accept: 'application/json' } });
    if (!r.ok) return { status: 502, json: { error: 'itunes search failed' } };
    const text = await r.text();
    return {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'public, max-age=3600',
      },
      body: text,
    };
  }

  if (type === 'audio') {
    let target;
    try {
      target = new URL(query.get('url') || '');
    } catch {
      return { status: 400, json: { error: 'bad url' } };
    }
    if (target.protocol !== 'https:' || !audioHostAllowed(target.hostname)) {
      return { status: 403, json: { error: 'host not allowed' } };
    }
    const r = await fetch(target.href);
    if (!r.ok) return { status: 502, json: { error: 'preview fetch failed' } };
    const buf = Buffer.from(await r.arrayBuffer());
    return {
      status: 200,
      headers: {
        'content-type': r.headers.get('content-type') || 'audio/mp4',
        'cache-control': 'public, max-age=86400',
      },
      body: buf,
    };
  }

  return { status: 400, json: { error: 'unknown type' } };
}

export default async function handler(req, res) {
  const query = new URL(req.url, 'http://localhost').searchParams;
  try {
    const out = await proxyRequest(query);
    res.statusCode = out.status;
    res.setHeader('access-control-allow-origin', '*');
    for (const [k, v] of Object.entries(out.headers || {})) res.setHeader(k, v);
    if (out.json) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(out.json));
    } else {
      res.end(out.body);
    }
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: String(err && err.message) }));
  }
}
