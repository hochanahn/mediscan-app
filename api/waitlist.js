// Collects waitlist emails. Logs them so you can see them in Vercel logs.

var emails = [];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    var body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    var email = (body.email || '').trim();
    if (!email || email.indexOf('@') < 0) { res.status(400).json({ error: 'Invalid email' }); return; }

    var entry = { email: email, time: new Date().toISOString() };
    emails.push(entry);

    console.log('WAITLIST_SIGNUP', JSON.stringify(entry));

    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
