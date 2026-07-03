/**
 * NEXORA AI — Email Tracking Server
 * ──────────────────────────────────
 * Endpoints:
 *   GET /pixel?id=EMAIL_ID          → returns 1×1 transparent GIF, logs open
 *   GET /click?id=EMAIL_ID&url=URL  → logs click, redirects to URL
 *   GET /api/events                 → returns all events as JSON
 *   GET /api/stats                  → returns summary stats
 *   GET /                           → serves the dashboard
 *
 * Storage: flat JSON file in /data/events.json (no database needed)
 * Deploy:  Railway / Render / Fly.io — free tier, 1-click
 */

const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const cors     = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── paths ──────────────────────────────────────────────────────────────────
const DATA_DIR   = path.join(__dirname, 'data');
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');
const DASH_FILE  = path.join(__dirname, 'dashboard.html');

// ensure data dir + file exist
if (!fs.existsSync(DATA_DIR))  fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(EVENTS_FILE)) fs.writeFileSync(EVENTS_FILE, JSON.stringify([]));

// ── 1×1 transparent GIF (binary, hardcoded — no file needed) ───────────────
const TRANSPARENT_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

// ── helpers ────────────────────────────────────────────────────────────────
function loadEvents() {
  try { return JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8')); }
  catch { return []; }
}

function saveEvent(event) {
  const events = loadEvents();
  events.push(event);
  fs.writeFileSync(EVENTS_FILE, JSON.stringify(events, null, 2));
}

function sanitizeId(id) {
  // keep emailId short, printable, and safe to store/display
  return String(id || 'unknown').slice(0, 120).replace(/[\r\n\t]/g, '');
}

// Returns true if the id is a literal un-replaced placeholder
function isPlaceholder(id) {
  return /^\{\{.*\}\}$/.test(id) || id === 'unknown';
}

// Dedup: returns true if we already recorded an open for this emailId+ip
// within the last DEDUP_MS milliseconds (prevents Gmail/Apple prefetch spam)
const DEDUP_MS = 5 * 60 * 1000; // 5 minutes
function isDuplicate(emailId, ip) {
  const events = loadEvents();
  const cutoff = Date.now() - DEDUP_MS;
  return events.some(e =>
    e.type === 'open' &&
    e.emailId === emailId &&
    e.ip === ip &&
    new Date(e.timestamp).getTime() > cutoff
  );
}

function isSafeUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function getIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

function parseUA(ua = '') {
  if (/iPhone|iPad|iPod/i.test(ua))   return '📱 iOS';
  if (/Android/i.test(ua))            return '📱 Android';
  if (/Outlook/i.test(ua))            return '💻 Outlook';
  if (/Thunderbird/i.test(ua))        return '💻 Thunderbird';
  if (/Mac OS/i.test(ua))             return '💻 macOS';
  if (/Windows/i.test(ua))            return '💻 Windows';
  return '🌐 Other';
}

// ── middleware ─────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── PIXEL ENDPOINT — logs "open" ───────────────────────────────────────────
app.get('/pixel', (req, res) => {
  const id = sanitizeId(req.query.id);
  const ip = getIp(req);

  // Always return the GIF immediately (must not delay the email render)
  res
    .set('Content-Type',  'image/gif')
    .set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    .set('Pragma',        'no-cache')
    .set('Expires',       '0')
    .status(200)
    .send(TRANSPARENT_GIF);

  // Skip placeholder IDs and duplicate opens within 5 min from same IP
  if (isPlaceholder(id)) return;
  if (isDuplicate(id, ip)) return;

  saveEvent({
    type:      'open',
    emailId:   id,
    timestamp: new Date().toISOString(),
    ip,
    device:    parseUA(req.headers['user-agent']),
    userAgent: req.headers['user-agent'] || '',
  });
});

// ── CLICK ENDPOINT — logs "click" then redirects ───────────────────────────
app.get('/click', (req, res) => {
  const id  = sanitizeId(req.query.id);
  const raw = req.query.url;

  if (!raw) return res.status(400).send('Missing url parameter');

  let target;
  try { target = decodeURIComponent(raw); } catch { return res.status(400).send('Bad url parameter'); }

  if (!isSafeUrl(target)) return res.status(400).send('Unsafe or malformed url parameter');

  // Skip placeholder IDs
  if (!isPlaceholder(id)) {
    saveEvent({
      type:      'click',
      emailId:   id,
      url:       target,
      timestamp: new Date().toISOString(),
      ip:        getIp(req),
      device:    parseUA(req.headers['user-agent']),
      userAgent: req.headers['user-agent'] || '',
    });
  }

  res.redirect(302, target);
});

// ── API: health check (used by dashboard to detect a live server) ─────────
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ── API: all events ────────────────────────────────────────────────────────
app.get('/api/events', (req, res) => {
  const events = loadEvents();
  // optional filter by emailId
  const { id } = req.query;
  res.json(id ? events.filter(e => e.emailId === id) : events);
});

// ── API: summary stats ─────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const events = loadEvents();
  const opens  = events.filter(e => e.type === 'open');
  const clicks = events.filter(e => e.type === 'click');

  // unique opens (by emailId)
  const uniqueOpens  = [...new Set(opens.map(e => e.emailId))].length;
  const uniqueClicks = [...new Set(clicks.map(e => e.emailId))].length;

  // device breakdown — percentage based on totalOpens
  const devRaw = {};
  opens.forEach(e => { devRaw[e.device] = (devRaw[e.device] || 0) + 1; });
  const devices = {};
  const totalO = opens.length || 1;
  Object.entries(devRaw).forEach(([k, v]) => {
    devices[k] = { count: v, pct: Math.round((v / totalO) * 100) };
  });

  // opens over time (last 7 days)
  const timeline = {};
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    timeline[d.toISOString().slice(0, 10)] = 0;
  }
  opens.forEach(e => {
    const day = e.timestamp.slice(0, 10);
    if (day in timeline) timeline[day]++;
  });

  const clickRate = uniqueOpens ? Math.round((uniqueClicks / uniqueOpens) * 100) : 0;

  res.json({
    totalOpens:    opens.length,
    uniqueOpens,
    totalClicks:   clicks.length,
    uniqueClicks,
    clickRate,
    devices,
    timeline,
    recentEvents:  events.slice(-20).reverse(),
  });
});

// ── CLEAR ALL EVENTS (reset dashboard) ────────────────────────────────────
app.post('/api/clear', (req, res) => {
  fs.writeFileSync(EVENTS_FILE, JSON.stringify([]));
  res.json({ ok: true, message: 'All events cleared.' });
});

// ── EMAIL GENERATOR ────────────────────────────────────────────────────────
app.get('/generator', (req, res) => {
  const genFile = path.join(__dirname, 'email-generator.html');
  if (fs.existsSync(genFile)) {
    res.sendFile(genFile);
  } else {
    res.send('<h2>email-generator.html not found.</h2>');
  }
});

// ── DASHBOARD ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  if (fs.existsSync(DASH_FILE)) {
    res.sendFile(DASH_FILE);
  } else {
    res.send('<h2>Dashboard file not found. Place dashboard.html next to server.js</h2>');
  }
});

// ── START ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅  NEXORA Tracker running on port ${PORT}`);
  console.log(`   Dashboard : http://localhost:${PORT}/`);
  console.log(`   Pixel     : http://localhost:${PORT}/pixel?id=TEST`);
  console.log(`   Click     : http://localhost:${PORT}/click?id=TEST&url=https://nexora.ai`);
  console.log(`   API stats : http://localhost:${PORT}/api/stats\n`);
});
