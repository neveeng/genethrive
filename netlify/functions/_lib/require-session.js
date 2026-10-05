/**
 * GeneThrive — shared guard for functions that return clinical data
 * (get-client-full-record.js, list-clients.js, the new export-client-package.js)
 * requiring a valid practitioner session token (see session-token.js /
 * authenticate-practitioner.js).
 *
 * SAFE-BY-DEFAULT: only enforced when REQUIRE_PRACTITIONER_TOKEN=true is set
 * as a Netlify environment variable. Left unset (today's actual deployment
 * state — no live Supabase/Netlify project exists yet), every caller of this
 * helper behaves EXACTLY as before this file existed: no behaviour change,
 * same as every other addition in this session. Once a real deployment sets
 * PRACTITIONER_PIN_HASHES + PRACTITIONER_SESSION_SECRET and the Portal's
 * front-end is updated to call authenticate-practitioner.js and send the
 * returned token as `Authorization: Bearer <token>` on every request, set
 * REQUIRE_PRACTITIONER_TOKEN=true to start enforcing it.
 *
 * Returns { ok: true, practitionerId } or { ok: false, statusCode, error }.
 */
import { verify } from './session-token';

function requireSession(event) {
  if (process.env.REQUIRE_PRACTITIONER_TOKEN !== 'true') {
    return { ok: true, practitionerId: null, enforced: false };
  }
  // Accept token from either:
  //   Authorization: Bearer <token>   (standard)
  //   X-Practitioner-Token: <token>   (portal's custom header)
  const authHeader = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const customHeader = (event.headers && (event.headers['x-practitioner-token'] || event.headers['X-Practitioner-Token'])) || '';
  const token = authHeader.replace(/^Bearer\s+/i, '') || customHeader;
  const payload = verify(token);
  if (!payload) {
    return { ok: false, statusCode: 401, error: 'Missing or invalid/expired session token' };
  }
  return { ok: true, practitionerId: payload.practitionerId, enforced: true };
}

export default { requireSession };
