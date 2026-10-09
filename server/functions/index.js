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
exports.preview = onCall({ timeoutSeconds: 20, memory: '256MiB' }, async req => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in first');
  const url = String((req.data && req.data.url) || '');
  if (!/^https?:\/\//i.test(url)) throw new HttpsError('invalid-argument', 'Bad URL');
  const fbish = /facebook\.com|fb\.watch|fb\.me|fb\.com/i.test(url);
  const ua = fbish ? 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'
    : 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, { redirect: 'follow', signal: ctrl.signal, headers: { 'user-agent': ua, accept: 'text/html,application/xhtml+xml', 'accept-language': 'en,es;q=0.8' } });
    const html = (await r.text()).slice(0, 800000);
    const abs = u => { try { return u ? new URL(u, r.url).href : ''; } catch (e) { return ''; } };
    const title = metaTag(html, 'og:title') || metaTag(html, 'twitter:title') || ent((html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]);
    const desc = metaTag(html, 'og:description') || metaTag(html, 'twitter:description') || metaTag(html, 'description');
    const img = abs(metaTag(html, 'og:image') || metaTag(html, 'og:image:url') || metaTag(html, 'twitter:image'));
    const site = metaTag(html, 'og:site_name');
    return { title, desc, img, site, finalUrl: r.url };
  } catch (e) { return { error: String(e.message || e) }; } finally { clearTimeout(t); }
});

// Notification rules go here once the criteria are defined.
