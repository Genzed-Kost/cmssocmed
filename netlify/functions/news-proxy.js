/**
 * Netlify Function: Google News RSS Proxy
 * Fetch Google News RSS untuk query "Prabowo Subianto" dan kembalikan sebagai JSON.
 * Menghindari CORS block saat dipanggil dari browser.
 */

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  const query = event.queryStringParameters?.q || 'Prabowo Subianto kebijakan pemerintah';
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=id&gl=ID&ceid=ID:id`;

  try {
    const res = await fetch(rssUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CMSBot/1.0)' }
    });
    if (!res.ok) throw new Error(`RSS fetch failed: ${res.status}`);

    const xml = await res.text();

    // Parse <item> blocks dari RSS XML
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null && items.length < 7) {
      const block = match[1];
      const title  = (block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) ||
                      block.match(/<title>([\s\S]*?)<\/title>/))?.[1]?.trim() || '';
      const link   = (block.match(/<link>([\s\S]*?)<\/link>/) ||
                      block.match(/<link\s*\/?>([\s\S]*?)<\/link>/))?.[1]?.trim() || '';
      const pubDate = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim() || '';
      const source  = block.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1]?.trim() || '';
      const desc    = (block.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) ||
                      block.match(/<description>([\s\S]*?)<\/description>/))?.[1]?.trim() || '';

      // Bersihkan HTML tags dari description
      const cleanDesc = desc.replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ' ').trim();

      if (title && link) {
        items.push({ title, link, pubDate, source, desc: cleanDesc.slice(0, 300) });
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
