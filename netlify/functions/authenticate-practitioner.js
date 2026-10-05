/**
 * GeneThrive — real, server-side practitioner PIN verification.
 *
 * WHY THIS EXISTS: the Engine's own authenticatePractitioner() (in the
 * shipped HTML file) compares a SHA-256 hash that is ALSO shipped in that
 * same file — anyone with the file can read the hash, or just open devtools
 * and call `_sessionPractitioner = PRACTITIONER_REGISTRY.barbara_baldwin`
 * directly, bypassing the PIN check entirely. The Engine's own changelog
 * (v3.5.120, 12 Sep 2026, an independent Grok audit) already says this
 * plainly: "this remains a client-side check, not server authentication...
 * that remains a separate future workstream." This function is the start of
 * that workstream: a PIN check where the hash never leaves the server, so
 * reading or editing the client can no longer reveal or bypass it.
 *
 * POST { pin } -> on match: { ok: true, practitionerId, token } (token from
 * session-token.js, short-lived). On no match: { ok: false }, always 200 (not
 * 401) and with no timing/content difference between "wrong PIN" and
 * "unknown PIN", so this endpoint doesn't itself become a way to enumerate
 * valid practitioner PINs.
 *
 * ENVIRONMENT VARIABLES NEEDED:
 *   PRACTITIONER_PIN_HASHES — a JSON object, e.g.
 *     {"barbara_baldwin": {"pinHash": "<sha256 hex of her PIN>", "name": "Barbara Baldwin"}}
 *   Generate a hash with: node -e "console.log(require('crypto').createHash('sha256').update('8100').digest('hex'))"
 *   Set this ONLY as a Netlify environment variable — never commit it to any
 *   file, unlike the Engine's own pinHash (which has to ship in the HTML
 *   because that file is a standalone offline tool with nowhere else to look
 *   it up from).
 *   PRACTITIONER_SESSION_SECRET — see session-token.js.
 */
import { createHash } from 'crypto';
import { sign } from './_lib/session-token';

export async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Invalid JSON body' }) };
  }

  const pin = body.pin;
  if (!pin) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'pin is required' }) };
  }

  let registry;
  try {
    registry = JSON.parse(process.env.PRACTITIONER_PIN_HASHES || '{}');
  } catch (e) {
    console.error('authenticate-practitioner: PRACTITIONER_PIN_HASHES is not valid JSON');
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Server misconfigured' }) };
  }

  const hash = createHash('sha256').update(String(pin)).digest('hex');
  const match = Object.entries(registry).find(([, entry]) => entry.pinHash === hash);

  if (!match) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false }) };
  }

  const [practitionerId] = match;
  const token = sign(practitionerId);
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, practitionerId, token }),
  };
}
