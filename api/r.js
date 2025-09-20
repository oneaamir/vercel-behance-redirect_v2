// api/r.js
// Vercel serverless redirect endpoint with support for multiple tracker URLs.
// - Notifies Apps Script tracker URLs (TRACKER_URLS / TRACKER_URL / TRACKER_URL_1...).
// - Validates dest (optional ALLOWED_DOMAINS whitelist).
// - Responds with 302 Location to the dest.

const DEFAULT_TRACK_TIMEOUT_MS = 700; // per-tracker timeout
const REQUIRE_HTTPS_FOR_TRACKERS = true; // set to false if you need http trackers

function escapeHtml(s){ return (s+'').replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[c])); }

function normalizeDest(raw) {
  if (!raw) return null;
  raw = String(raw);
  try { raw = decodeURIComponent(raw); } catch (e) { /* ignore decode errors */ }
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) raw = 'https://' + raw;
  try {
    const u = new URL(raw);
    if (!/^https?:$/i.test(u.protocol)) return null;
    return u.toString();
  } catch (e) {
    return null;
  }
}

// Validate and normalize a tracker URL string. Returns normalized string or null.
function normalizeTrackerUrl(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  try {
    // If missing scheme, prefer https
    const maybe = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s) ? s : 'https://' + s;
    const u = new URL(maybe);
    if (!/^https?:$/i.test(u.protocol)) return null;
    if (REQUIRE_HTTPS_FOR_TRACKERS && u.protocol.toLowerCase() !== 'https:') return null;
    // Keep URL as-is (including any path); no trailing whitespace.
    return u.toString();
  } catch (e) {
    return null;
  }
}

function getTrackerListFromEnv() {
  const out = [];
  const env = process.env || {};

  // 1) TRACKER_URLS comma-separated
  if (env.TRACKER_URLS) {
    env.TRACKER_URLS.split(',').forEach(s => {
      const n = normalizeTrackerUrl(s);
      if (n) out.push(n);
    });
  }

  // 2) single legacy TRACKER_URL
  if (env.TRACKER_URL) {
    const n = normalizeTrackerUrl(env.TRACKER_URL);
    if (n) out.push(n);
  }

  // 3) numbered legacy vars TRACKER_URL_1, TRACKER_URL_2, ...
  Object.keys(env).forEach(k => {
    const m = k.match(/^TRACKER_URL_(\d+)$/);
    if (m && env[k]) {
      const n = normalizeTrackerUrl(env[k]);
      if (n) out.push(n);
    }
  });

  // remove empties and duplicates while keeping order
  const seen = new Set();
  return out.filter(u => {
    if (!u) return false;
    if (seen.has(u)) return false;
    seen.add(u);
    return true;
  });
}

module.exports = async (req, res) => {
  try {
    const { rid = '', dest: rawDest } = req.query || {};

    if (!rawDest) {
      res.statusCode = 400;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end('Missing dest parameter');
      return;
    }

    const dest = normalizeDest(rawDest);
    if (!dest) {
      res.statusCode = 400;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end('Invalid dest URL');
      return;
    }

    // Optional domain whitelist
    const allowed = process.env.ALLOWED_DOMAINS || '';
    if (allowed.trim()) {
      const host = new URL(dest).hostname;
      const allowedList = allowed.split(',').map(s => s.trim()).filter(Boolean);
      const ok = allowedList.some(a => host === a || host.endsWith('.' + a));
      if (!ok) {
        res.statusCode = 403;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end('Destination domain not allowed');
        return;
      }
    }

    // Build trackers list (validated normalized URLs)
    const trackers = getTrackerListFromEnv();

    if (trackers.length) {
      try {
        const promises = trackers.map((base) => {
          // append query params (rid, dest, via=vercel)
          const trackerUrl = base + (base.indexOf('?') === -1 ? '?' : '&') +
            'action=track&rid=' + encodeURIComponent(rid || '') +
            '&dest=' + encodeURIComponent(dest) +
            '&via=vercel';

          const ac = new AbortController();
          const timeout = setTimeout(() => ac.abort(), DEFAULT_TRACK_TIMEOUT_MS);

          const p = fetch(trackerUrl, { method: 'GET', signal: ac.signal })
            .catch(() => { /* ignore individual failures */ })
            .finally(() => clearTimeout(timeout));

          return p;
        });

        // Wait for all to settle; each promise has per-request timeout.
        await Promise.allSettled(promises).catch(() => {});
      } catch (e) {
        // ignore tracker system failures - do not block redirect
      }
    }

    // Issue redirect (HTTP 302)
    res.statusCode = 302;
    res.setHeader('Location', dest);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<html><body>Redirecting… If you are not redirected automatically, <a href="${escapeHtml(dest)}">click here</a>.</body></html>`);
  } catch (err) {
    console.error('redirect error', err);
    try {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Server error');
    } catch (e) {}
  }
};
