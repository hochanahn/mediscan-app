// Vercel Serverless Function — keeps the Claude API key hidden on the server.
// The browser calls /api/analyze; this function adds the secret key and forwards to Anthropic.

// ── In-memory rate limiter ────────────────────────────
// Note: serverless instances are ephemeral, so this resets on cold starts.
// It blocks rapid macro abuse within a warm instance. For production-grade
// limits across all instances, swap this for Upstash Redis later.
var ipHits = {};               // { ip: [timestamp, timestamp, ...] }
var WINDOW_MS = 60 * 1000;     // 1 minute
var MAX_PER_WINDOW = 5;        // max 5 requests per IP per minute
var DAILY_MAX = 30;            // soft daily cap per IP (per warm instance)
var ipDaily = {};              // { ip: { day: 'YYYY-MM-DD', count: n } }

function getClientIp(req) {
  var fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers['x-real-ip'] || 'unknown';
}

function checkRateLimit(ip) {
  var now = Date.now();
  // Per-minute window
  if (!ipHits[ip]) ipHits[ip] = [];
  ipHits[ip] = ipHits[ip].filter(function(t){ return now - t < WINDOW_MS; });
  if (ipHits[ip].length >= MAX_PER_WINDOW) {
    return { ok: false, reason: 'Too many requests. Please wait a minute and try again.' };
  }
  // Per-day soft cap
  var today = new Date().toISOString().slice(0, 10);
  if (!ipDaily[ip] || ipDaily[ip].day !== today) ipDaily[ip] = { day: today, count: 0 };
  if (ipDaily[ip].count >= DAILY_MAX) {
    return { ok: false, reason: 'Daily limit reached. Please try again tomorrow or upgrade your plan.' };
  }
  // Record this hit
  ipHits[ip].push(now);
  ipDaily[ip].count++;
  return { ok: true };
}

export default async function handler(req, res) {
  // CORS for safety (same-origin in production)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  // Rate limit check
  var ip = getClientIp(req);
  var rl = checkRateLimit(ip);
  if (!rl.ok) { res.status(429).json({ error: rl.reason }); return; }

  var apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'Server API key not configured' }); return; }

  try {
    var body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    var images = body.images || [];           // array of { media, data }
    if (!images.length) { res.status(400).json({ error: 'No images provided' }); return; }
    if (images.length > 5) { res.status(400).json({ error: 'Maximum 5 images per request' }); return; }

    var SYSTEM_PROMPT = "You are an expert radiologist AI. Analyze the medical image(s) and respond ONLY with a JSON object.\n\nRULES:\n1. First identify the imaging type (X-ray, CT, MRI) and body region yourself.\n2. Check for abnormalities FIRST before declaring normal.\n3. Compare LEFT vs RIGHT sides for asymmetry.\n4. Brain CT: hyperdense (bright) = possible bleeding. NEVER miss hemorrhage.\n5. Chest X-ray: check lungs, heart, mediastinum, bones separately.\n6. NEVER say normal unless all structures are checked.\n7. Flag asymmetry or bright lesions as finding #1 urgent.\n\nJSON format (respond with ONLY this, no markdown):\n{\"detected_type\":\"<X-ray|CT|MRI> of <region>\",\"overall_score\":<0-100>,\"overall\":\"<one sentence plain English>\",\"findings\":[{\"rank\":<1-5>,\"title\":\"<plain English>\",\"severity\":\"<urgent|attention|normal>\",\"location\":\"<e.g. Right lower lobe>\",\"score\":<0-100>,\"summary\":\"<1-2 sentences, no jargon>\",\"detail\":\"<technical detail>\",\"bbox\":{\"x\":0.0,\"y\":0.0,\"w\":0.0,\"h\":0.0}}],\"technical\":{\"image_quality\":\"<brief>\",\"limitations\":\"<what AI cannot determine>\",\"scan_parameters\":\"<visible params>\"}}";

    var content = [];
    for (var i = 0; i < images.length; i++) {
      content.push({ type: 'image', source: { type: 'base64', media_type: images[i].media, data: images[i].data } });
    }
    content.push({ type: 'text', text: SYSTEM_PROMPT + '\n\nAnalyze the image(s). Return ONLY valid JSON, no markdown, no extra text.' });

    var models = ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];
    var data = null, lastErr = null;

    for (var m = 0; m < models.length; m++) {
      for (var attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await new Promise(function(r){ setTimeout(r, 2000 * attempt); });
        var r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: models[m], max_tokens: 1500, messages: [{ role: 'user', content: content }] })
        });
        data = await r.json();
        if (!data.error) { m = models.length; break; }
        lastErr = (data.error && data.error.message) || 'API error';
        if (r.status === 529 || r.status === 503) continue;
        break;
      }
    }

    if (!data || data.error) { res.status(502).json({ error: lastErr || 'API error' }); return; }

    var raw = (data.content && data.content[0] && data.content[0].text) ? data.content[0].text : '';
    res.status(200).json({ text: raw });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
