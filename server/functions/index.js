const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

initializeApp();
const db = getFirestore();

// Sends a notification to every device where this user turned notifications on.
async function sendToUser(uid, { title, body, url }) {
  const ref = db.collection('users').doc(uid).collection('tokens');
  const tokens = (await ref.get()).docs.map(d => d.id);
  if (!tokens.length) return { sent: 0 };
  const res = await getMessaging().sendEachForMulticast({
    tokens,
    data: { title: title || 'PinLab', body: body || '', url: url || './' },
    webpush: { headers: { Urgency: 'normal' } }
  });
  const dead = [];
  res.responses.forEach((r, i) => {
    const code = r.error && r.error.code;
    if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') dead.push(tokens[i]);
  });
  await Promise.all(dead.map(t => ref.doc(t).delete()));
  return { sent: res.successCount };
}

// "Send test notification" button in Settings.
exports.sendTest = onCall(async req => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in first');
  return sendToUser(req.auth.uid, { title: 'PinLab', body: 'Notifications are working.' });
});

// Link preview: fetches the page server-side (no CORS) and reads its title, description and image.
const ent = s => (s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).trim();
function metaTag(html, key) {
  const re = new RegExp('<meta[^>]+(?:property|name)=["\']' + key.replace(/[:.]/g, '\\$&') + '["\'][^>]*>', 'i');
  const tag = (html.match(re) || [])[0]; if (!tag) return '';
  return ent((tag.match(/content="([^"]*)"/i) || tag.match(/content='([^']*)'/i) || [])[1]);
}
const BOT_UAS = ['facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)', 'Twitterbot/1.0', 'WhatsApp/2.23.20.0'];
const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const genericImg = u => !u || /static\.xx\.fbcdn\.net\/rsrc\.php|facebook\.com\/images\/fb_icon|\/rsrc\.php\//i.test(u);
async function grab(url, ua, ms) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { redirect: 'follow', signal: ctrl.signal, headers: { 'user-agent': ua, accept: 'text/html,application/xhtml+xml', 'accept-language': 'en,es;q=0.8' } });
    const html = (await r.text()).slice(0, 800000);
    const abs = u => { try { return u ? new URL(u, r.url).href : ''; } catch (e) { return ''; } };
    let img = abs(metaTag(html, 'og:image') || metaTag(html, 'og:image:url') || metaTag(html, 'og:image:secure_url') || metaTag(html, 'twitter:image'));
    if (genericImg(img)) img = '';
    return { title: metaTag(html, 'og:title') || metaTag(html, 'twitter:title') || ent((html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]),
      desc: metaTag(html, 'og:description') || metaTag(html, 'twitter:description') || metaTag(html, 'description'), img, site: metaTag(html, 'og:site_name'), finalUrl: r.url };
  } finally { clearTimeout(t); }
}
// Downloads the image so the app keeps its own copy (Facebook image links expire and block other sites).
async function imgData(src, referer) {
  const fbImg = /fbsbx\.com|fbcdn\.net|facebook\.com/i.test(src);
  for (const ua of (fbImg ? [BOT_UAS[0], SAFARI] : [SAFARI, BOT_UAS[0]])) { const d = await imgTry(src, referer, ua); if (d) return d; }
  return '';
}
async function imgTry(src, referer, ua) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(src, { redirect: 'follow', signal: ctrl.signal, headers: { 'user-agent': ua, accept: 'image/*,*/*;q=0.8', referer: referer || '' } });
    const type = (r.headers.get('content-type') || '').split(';')[0];
    if (!r.ok || !/^image\//.test(type)) return '';
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 4000000) return '';
    return 'data:' + type + ';base64,' + buf.toString('base64');
  } catch (e) { return ''; } finally { clearTimeout(t); }
}
// Reddit: read the post's own data (title, text, picture) from Reddit's JSON.
async function redditPost(url) {
  const m = url.match(/\/comments\/([a-z0-9]+)/i); if (!m) return null;
  const tries = ['https://www.reddit.com/comments/' + m[1] + '.json?raw_json=1', 'https://old.reddit.com/comments/' + m[1] + '.json?raw_json=1', 'https://api.reddit.com/comments/' + m[1] + '?raw_json=1'];
  for (const u of tries) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 7000);
    try {
      const r = await fetch(u, { signal: ctrl.signal, headers: { 'user-agent': 'web:pinlab:1.0 (bookmark preview)', accept: 'application/json' } });
      if (!r.ok) continue;
      const j = await r.json(); const d = j && j[0] && j[0].data.children[0].data; if (!d) continue;
      const pv = d.preview && d.preview.images && d.preview.images[0];
      const gal = d.media_metadata && Object.values(d.media_metadata)[0];
      const img = (pv && pv.source && pv.source.url) || (gal && gal.s && (gal.s.u || gal.s.gif)) || (/\.(jpe?g|png|webp|gif)$/i.test(d.url_overridden_by_dest || '') ? d.url_overridden_by_dest : '') || (/^https?:/.test(d.thumbnail || '') ? d.thumbnail : '');
      return { title: d.title || '', desc: (d.selftext || '').slice(0, 240) || ('r/' + d.subreddit + ' · u/' + d.author), img: ent(img), sub: d.subreddit, author: d.author };
    } catch (e) {} finally { clearTimeout(t); }
  }
  return null;
}
// Fallback: link-fixer mirrors (made for Discord/Telegram) that repeat the post's real title, text and photo.
async function redditMirror(url) {
  const path = (() => { try { return new URL(url).pathname; } catch (e) { return ''; } })();
  if (!/\/comments\//.test(path)) return null;
  for (const host of ['https://rxddit.com', 'https://vxreddit.com', 'https://www.rxddit.com']) {
    try {
      const d = await grab(host + path, 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)', 7000);
      const title = (d.title || '').replace(/^From the (\S+) community on Reddit:\s*/i, '');
      if (!title || /^(reddit|rxddit|vxreddit)/i.test(title)) continue;
      const desc = /^Explore this post and more from/i.test(d.desc || '') ? '' : (d.desc || '');
      const sub = (path.match(/\/r\/([^/]+)/) || [])[1] || '';
      return { title, desc: desc || (sub ? 'r/' + sub : ''), img: /share\.redd\.it\/preview/.test(d.img || '') ? '' : d.img, sub };
    } catch (e) {}
  }
  return null;
}
// Site logo: looks for the brand logo in the homepage header, then structured data, then touch icons.
function attrsOf(tag) { const o = {}; tag.replace(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g, (m, k, v, a, b, c) => { o[k.toLowerCase()] = ent(a ?? b ?? c ?? ''); return m; }); return o; }
function imgSrc(a) { const s = a['data-src'] || a['data-lazy-src'] || a.src || ''; if (s && !/^data:image\/gif|blank|spacer|pixel/i.test(s)) return s; const ss = (a.srcset || a['data-srcset'] || '').split(',').pop(); return ss ? ss.trim().split(/\s+/)[0] : ''; }
function findLogo(html) {
  const isLogo = s => /logo|brand|masthead|site-?title/i.test(s || '');
  const scopes = [(html.match(/<header[\s\S]*?<\/header>/i) || [])[0], (html.match(/<nav[\s\S]*?<\/nav>/i) || [])[0], html.slice(0, 60000)].filter(Boolean);
  for (const sc of scopes) {
    const linked = sc.match(/<a[^>]*(?:class|id|aria-label)\s*=\s*["'][^"']*(?:logo|brand|home)[^"']*["'][^>]*>([\s\S]{0,4000}?)<\/a>/i);
    if (linked) { const im = linked[1].match(/<img\b[^>]*>/i); if (im) { const s = imgSrc(attrsOf(im[0])); if (s) return { src: s }; }
      const sv = linked[1].match(/<svg[\s\S]*?<\/svg>/i); if (sv && sv[0].length > 200) return { svg: sv[0] }; }
    for (const im of sc.match(/<img\b[^>]*>/gi) || []) { const a = attrsOf(im); if (isLogo(a.class) || isLogo(a.id) || isLogo(a.alt) || isLogo(a.src) || isLogo(a['data-src'])) { const s = imgSrc(a); if (s) return { src: s }; } }
    const sv = sc.match(/<svg[^>]*(?:class|id|aria-label)\s*=\s*["'][^"']*logo[^"']*["'][\s\S]*?<\/svg>/i); if (sv) return { svg: sv[0] };
  }
  const ld = html.match(/"logo"\s*:\s*(?:\{[^}]*?"url"\s*:\s*)?"([^"]+)"/i); if (ld) return { src: ld[1].replace(/\\\//g, '/') };
  const ati = html.match(/<link[^>]*rel=["'][^"']*apple-touch-icon[^"']*["'][^>]*>/i); if (ati) { const h = attrsOf(ati[0]).href; if (h) return { src: h, icon: true }; }
  return null;
}
async function siteLogo(url) {
  let origin; try { origin = new URL(url).origin; } catch (e) { return {}; }
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 9000);
  try {
    const r = await fetch(origin + '/', { redirect: 'follow', signal: ctrl.signal, headers: { 'user-agent': SAFARI, accept: 'text/html' } });
    const html = (await r.text()).slice(0, 600000);
    const f = findLogo(html); if (!f) return {};
    if (f.svg) { let s = f.svg; if (!/xmlns=/.test(s)) s = s.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"'); s = s.replace(/currentColor/g, '#201e1d'); return { logoData: 'data:image/svg+xml;base64,' + Buffer.from(s).toString('base64'), logoIcon: false }; }
    const abs = new URL(f.src, r.url).href;
    const d = await imgData(abs, r.url);
    return d ? { logoData: d, logoIcon: !!f.icon } : {};
  } catch (e) { return {}; } finally { clearTimeout(t); }
}
exports.preview = onCall({ timeoutSeconds: 30, memory: '512MiB' }, async req => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in first');
  const url = String((req.data && req.data.url) || '');
  if (!/^https?:\/\//i.test(url)) throw new HttpsError('invalid-argument', 'Bad URL');
  if (req.data && req.data.logo) return await siteLogo(url);
  const onlyImg = String((req.data && req.data.img) || '');
  if (/^https?:\/\//i.test(onlyImg)) return { imgData: await imgData(onlyImg, url) };
  if (/reddit\.com|redd\.it/i.test(url)) {
    let target = url;
    if (/\/s\/|redd\.it/i.test(url)) { try { const r = await fetch(url, { redirect: 'follow', headers: { 'user-agent': SAFARI } }); target = r.url || url; } catch (e) {} }
    let p = await redditPost(target);
    if (!p) p = await redditMirror(target);
    if (p) { p.rd = true; p.finalUrl = target; if (p.img) p.imgData = await imgData(p.img, target); if (p.img || p.title) return p; }
  }
  const fbish = /facebook\.com|fb\.watch|fb\.me|fb\.com/i.test(url);
  const bad = t => /^(facebook|log in|log into facebook|log in or sign up to view|instagram)$/i.test((t || '').trim());
  let out = {};
  try {
    const uas = fbish ? [...BOT_UAS, SAFARI] : [SAFARI, BOT_UAS[0]];
    const res = await Promise.all(uas.map(ua => grab(url, ua, 8000).catch(e => ({ error: String(e.message || e) }))));
    out.tried = res.map((d, i) => ({ ua: uas[i].split('/')[0], title: d.title || '', img: !!d.img, error: d.error || '' }));
    for (const d of res) { if (d.error) continue; if (bad(d.title)) d.title = '';
      out = { ...d, ...out, img: out.img || d.img, title: out.title || d.title, desc: out.desc || d.desc }; }
    if (out.title) out.title = out.title.replace(/^From the (\S+) community on Reddit:\s*/i, '');
    if (/^Explore this post and more from/i.test(out.desc || '')) out.desc = '';
    if (out.img && req.data.withImage !== false) out.imgData = await imgData(out.img, out.finalUrl || url);
    return out;
  } catch (e) { return { error: String(e.message || e) }; }
});

// Notification rules go here once the criteria are defined.
