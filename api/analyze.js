// Vercel Serverless Function — keeps the Claude API key hidden on the server.
// The browser calls /api/analyze; this function adds the secret key and forwards to Anthropic.

var ipHits = {};
var WINDOW_MS = 60 * 1000;
var MAX_PER_WINDOW = 5;
var DAILY_MAX = 30;
var ipDaily = {};

function getClientIp(req) {
  var fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers['x-real-ip'] || 'unknown';
}

function checkRateLimit(ip) {
  var now = Date.now();
  if (!ipHits[ip]) ipHits[ip] = [];
  ipHits[ip] = ipHits[ip].filter(function(t){ return now - t < WINDOW_MS; });
  if (ipHits[ip].length >= MAX_PER_WINDOW) {
    return { ok: false, reason: 'Too many requests. Please wait a minute and try again.' };
  }
  var today = new Date().toISOString().slice(0, 10);
  if (!ipDaily[ip] || ipDaily[ip].day !== today) ipDaily[ip] = { day: today, count: 0 };
  if (ipDaily[ip].count >= DAILY_MAX) {
    return { ok: false, reason: 'Daily limit reached. Please try again tomorrow or upgrade your plan.' };
  }
  ipHits[ip].push(now);
