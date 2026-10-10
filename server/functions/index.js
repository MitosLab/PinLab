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
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(src, { signal: ctrl.signal, headers: { 'user-agent': SAFARI, referer: referer || '' } });
    const type = (r.headers.get('content-type') || '').split(';')[0];
    if (!r.ok || !/^image\//.test(type)) return '';
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 4000000) return '';
    return 'data:' + type + ';base64,' + buf.toString('base64');
  } catch (e) { return ''; } finally { clearTimeout(t); }
}
exports.preview = onCall({ timeoutSeconds: 30, memory: '512MiB' }, async req => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in first');
  const url = String((req.data && req.data.url) || '');
  if (!/^https?:\/\//i.test(url)) throw new HttpsError('invalid-argument', 'Bad URL');
  const fbish = /facebook\.com|fb\.watch|fb\.me|fb\.com/i.test(url);
  const bad = t => /^(facebook|log in|log into facebook|log in or sign up to view|instagram)$/i.test((t || '').trim());
  let out = {};
  try {
    const uas = fbish ? [...BOT_UAS, SAFARI] : [SAFARI, BOT_UAS[0]];
    const res = await Promise.all(uas.map(ua => grab(url, ua, 8000).catch(e => ({ error: String(e.message || e) }))));
    out.tried = res.map((d, i) => ({ ua: uas[i].split('/')[0], title: d.title || '', img: !!d.img, error: d.error || '' }));
    for (const d of res) { if (d.error) continue; if (bad(d.title)) d.title = '';
      out = { ...d, ...out, img: out.img || d.img, title: out.title || d.title, desc: out.desc || d.desc }; }
    if (out.img && req.data.withImage !== false) out.imgData = await imgData(out.img, out.finalUrl || url);
    return out;
  } catch (e) { return { error: String(e.message || e) }; }
});

// Notification rules go here once the criteria are defined.
