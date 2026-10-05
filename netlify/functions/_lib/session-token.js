/**
 * GeneThrive — short-lived, server-signed session tokens for practitioner
 * authentication (see authenticate-practitioner.js). Hand-rolled HMAC-SHA256
 * via Node's built-in crypto module — no new dependency, same "only the
 * built-in fetch/crypto, no npm package" style as supabase-rest.js.
 *
 * Token shape: base64url(payload JSON) + "." + base64url(HMAC-SHA256 signature)
 * Payload: { practitionerId, iat, exp } (exp is a unix ms timestamp).
 *
 * REQUIRES the PRACTITIONER_SESSION_SECRET env var — a long random string,
 * generated once and stored ONLY as a Netlify environment variable, never in
 * any file in this project (unlike the Engine's pinHash, which IS shipped in
 * the HTML file by necessity of that file being a offline, standalone tool —
 * this secret must never be, since anyone with it could forge a valid
 * session for any practitioner).
 */
const crypto = require('crypto');

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

function getSecret() {
  const secret = process.env.PRACTITIONER_SESSION_SECRET;
  if (!secret) throw new Error('PRACTITIONER_SESSION_SECRET is not set — cannot issue or verify session tokens.');
  return secret;
}

function sign(practitionerId, ttlMs) {
  const payload = { practitionerId, iat: Date.now(), exp: Date.now() + (ttlMs || 2 * 3600 * 1000) };
  const payloadB64 = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', getSecret()).update(payloadB64).digest();
  return payloadB64 + '.' + b64url(sig);
}

/** Returns the payload object if valid and unexpired, otherwise null. */
function verify(token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') === -1) return null;
  const [payloadB64, sigB64] = token.split('.');
  const expectedSig = crypto.createHmac('sha256', getSecret()).update(payloadB64).digest();
  const givenSig = fromB64url(sigB64);
  if (expectedSig.length !== givenSig.length || !crypto.timingSafeEqual(expectedSig, givenSig)) return null;
  let payload;
  try {
    payload = JSON.parse(fromB64url(payloadB64).toString('utf8'));
  } catch (e) {
    return null;
  }
  if (!payload.exp || Date.now() > payload.exp) return null;
  return payload;
}

module.exports = { sign, verify };
