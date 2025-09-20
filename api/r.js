// api/r.js
// Minimal Vercel serverless redirect endpoint.
// - Best-effort notifies your Apps Script tracker URL (TRACKER_URL).
// - Validates dest (optional ALLOWED_DOMAINS whitelist).
// - Responds immediately with 302 Location to the dest.

const DEFAULT_TRACK_TIMEOUT_MS = 300; // Reduced timeout for faster redirects

// Helper: safe URL normalization
function normalizeDest(raw) {
  if (!raw) return null;
  raw = String(raw);
  // allow encoded values
  try { raw = decodeURIComponent(raw); } catch (e) { /* ignore */ }
  // add scheme if missing
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) raw = 'https://' + raw;
  try {
    const u = new URL(raw);
    // block obviously dangerous protocols
    if (!/^https?:$/i.test(u.protocol)) return null;
    return u.toString();
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
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

    // Optional domain whitelist - safer for avoiding open-redirect abuse.
    // Comma-separated hostnames in ALLOWED_DOMAINS env (e.g. "behance.net,example.com")
    const allowed = process.env.ALLOWED_DOMAINS || '';
    if (allowed.trim()) {
      const host = new URL(dest).hostname;
      const allowedList = allowed.split(',').map(s => s.trim()).filter(Boolean);
      const ok = allowedList.some(a => {
        // allow subdomains: domain match: host === a OR host.endsWith('.' + a)
        return host === a || host.endsWith('.' + a);
      });
      if (!ok) {
        res.statusCode = 403;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end('Destination domain not allowed');
        return;
      }
    }

    // Best-effort notify Apps Script trackers (if configured)
    // Support up to 20 tracker URLs
    const allTrackers = [];
    
    // Method 1: Primary tracker(s) - supports comma-separated
    const TRACKER_URLS = process.env.TRACKER_URLS || process.env.TRACKER_URL || '';
    if (TRACKER_URLS) {
      const urls = TRACKER_URLS.split(',').map(url => url.trim()).filter(Boolean);
      allTrackers.push(...urls);
    }
    
    // Method 2: Individual tracker URLs (TRACKER_URL_1 to TRACKER_URL_20)
    for (let i = 1; i <= 20; i++) {
      const envVar = i === 1 ? 'TRACKER_URL_1' : `TRACKER_URL_${i}`;
      const url = process.env[envVar] || '';
      if (url) {
        allTrackers.push(url.trim());
      }
    }
    
    // Method 3: Additional comma-separated URLs in specific environment variables
    const ADDITIONAL_TRACKERS = process.env.ADDITIONAL_TRACKERS || '';
    if (ADDITIONAL_TRACKERS) {
      const urls = ADDITIONAL_TRACKERS.split(',').map(url => url.trim()).filter(Boolean);
      allTrackers.push(...urls);
    }
    
    // Remove duplicates and empty strings
    const uniqueTrackers = [...new Set(allTrackers.filter(Boolean))];
    
    console.log('Found trackers:', uniqueTrackers);
    
    if (uniqueTrackers.length > 0) {
      // Notify all trackers in parallel (don't wait for all to complete)
      // This runs in background and doesn't block the redirect
      const notifyTrackers = () => {
        const trackerPromises = uniqueTrackers.map(async (trackerUrl) => {
          try {
            // Build tracker request - GET with query params
            // <-- IMPORTANT: we append &via=vercel so Apps Script uses the fast path -->
            const fullTrackerUrl = trackerUrl +
              (trackerUrl.indexOf('?') === -1 ? '?' : '&') +
              'action=track&rid=' + encodeURIComponent(rid || '') +
              '&dest=' + encodeURIComponent(dest) +
              '&via=vercel';

            console.log('Notifying tracker:', fullTrackerUrl);

            // Use AbortController to bound time spent waiting for tracker.
            const ac = new AbortController();
            const timeout = setTimeout(() => ac.abort(), DEFAULT_TRACK_TIMEOUT_MS);

            // fire-and-wait short timeout so redirect remains fast.
            const response = await fetch(fullTrackerUrl, { 
              method: 'GET', 
              signal: ac.signal,
              headers: {
                'User-Agent': 'Vercel-Redirect/1.0'
              }
            });
            
            console.log('Tracker response:', response.status, response.statusText);
            clearTimeout(timeout);
          } catch (e) {
            // ignore individual tracker failures - do not block redirect
            console.log('Tracker failed:', trackerUrl, e.message);
          }
        });
        
        // Run in background - don't await
        Promise.allSettled(trackerPromises).catch(() => { /* ignore */ });
      };
      
      // Start tracking in background immediately
      notifyTrackers();
    } else {
      console.log('No trackers configured');
    }

    // Issue redirect immediately (HTTP 302) - FASTEST POSSIBLE
    res.statusCode = 302;
    res.setHeader('Location', dest);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    // Minimal body for fastest redirect
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<html><head><meta http-equiv="refresh" content="0;url=${escapeHtml(dest)}"></head><body>Redirecting...</body></html>`);
  } catch (err) {
    console.error('redirect error', err);
    try {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Server error');
    } catch (e) {}
  }
}

function escapeHtml(s){ return (s+'').replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[c])); }
