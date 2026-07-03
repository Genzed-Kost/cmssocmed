/**
 * Netlify Function: Google News RSS Proxy
 * Fetch Google News RSS untuk query Prabowo dan kembalikan sebagai JSON.
 */

const https = require('https');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json'
};

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CMSBot/1.0)' }
    }, res => {
      // Follow redirect (301/302)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  const query = event.queryStringParameters?.q || 'Prabowo Subianto kebijakan pemerintah';
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=id&gl=ID&ceid=ID:id`;

  try {
    const xml = await httpsGet(rssUrl);

    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null && items.length < 7) {
      const block = match[1];
      const title   = (block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) ||
                       block.match(/<title>([\s\S]*?)<\/title>/))?.[1]?.trim() || '';
      const link    = block.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() ||
                      block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/)?.[1]?.trim() || '';
      const pubDate = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim() || '';
      const source  = block.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1]?.trim() || '';
      const desc    = (block.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) ||
                       block.match(/<description>([\s\S]*?)<\/description>/))?.[1]?.trim() || '';

      const cleanDesc = desc.replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/gi, ' ').trim().slice(0, 300);

      if (title && link) {
        items.push({ title, link, pubDate, source, desc: cleanDesc });
      }
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ items })
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: e.message })
    };
  }
};
