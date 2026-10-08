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

// Notification rules go here once the criteria are defined.
