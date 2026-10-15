/**
 * GeneThrive — Get Engine PIN
 * ─────────────────────────────────────────────────────────────────────────────
 * Netlify Function: netlify/functions/get-engine-pin.js
 *
 * CALLED BY: barbara-portal.html (openInEngine)
 *
 * Returns the Engine auto-login PIN from the BARBARA_ENGINE_PIN env var,
 * so the PIN is never hardcoded in the static HTML file.
 *
 * Protected by the practitioner session token (X-Practitioner-Token header).
 * Falls back gracefully if REQUIRE_PRACTITIONER_TOKEN is not yet enforced.
 *
 * ENVIRONMENT VARIABLES:
 *   PRACTITIONER_PIN          — the PIN the Engine uses for portal auto-login
 *   PRACTITIONER_TOKEN_SECRET — used to verify the session token (optional)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const crypto = require('crypto');

function verifyPractitionerToken(token) {
  try {
    const secret = process.env.PRACTITIONER_TOKEN_SECRET;
    if (!secret || !token) return false;
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const parts   = decoded.split(':');
    if (parts.length !== 3) return false;
    const [, expires, sig] = parts;
    if (Date.now() > parseInt(expires)) return false;
    const payload  = decoded.slice(0, decoded.lastIndexOf(':'));
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return sig === expected;
  } catch { return false; }
}

exports.handler = async function (event) {
  const corsHeaders = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Practitioner-Token',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'GET')    return { statusCode: 405, headers: corsHeaders, body: 'Method not allowed' };

  // Verify practitioner session token when secret is configured
  const token = event.headers['x-practitioner-token'];
  if (process.env.PRACTITIONER_TOKEN_SECRET && !verifyPractitionerToken(token)) {
    return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const pin = process.env.PRACTITIONER_PIN;
  if (!pin) {
    console.error('GeneThrive: PRACTITIONER_PIN env var not set');
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Engine PIN not configured' }) };
  }

  return {
    statusCode: 200,
    headers: { ...corsHeaders, 'Cache-Control': 'no-store' },
    body: JSON.stringify({ pin }),
  };
};