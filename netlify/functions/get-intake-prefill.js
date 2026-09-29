/**
 * GeneThrive — intake pre-fill lookup: token -> safe subset of client fields
 * =============================================================================
 *
 * WHAT CHANGED IN THIS RECONCILIATION
 *   `intake_token` used to live on the old ad hoc `clients` table; it now
 *   lives on `orders` (see shopify-order-webhook.js's "WHERE THE INTAKE TOKEN
 *   LIVES NOW" comment for why). This function now looks the token up in
 *   `orders`, then reads the identity/address fields from that order's
 *   `client_contacts` row — a real join, done as two REST calls (PostgREST
 *   embeds could do this in one call with `select=*,client_contacts(*)`, but
 *   two plain calls keep this function's error handling simple and matches
 *   the style already used by every other function in this project).
 *
 *   The response shape returned to the browser (firstName, lastName, email,
 *   mobile, addrStreet/Suburb/State/Postcode, clientId) is UNCHANGED — the
 *   intake wizard HTML that reads `window.GENETHRIVE_PREFILL` does not need
 *   to change at all. `clientId` in the response is now `orders.order_ref`
 *   (the same "GT-2026-0001"-style human reference as before, just sourced
 *   from a different column).
 *
 * WHY A TOKEN AND NOT THE ORDER REFERENCE DIRECTLY: unchanged reasoning — see
 * the original comment (order_ref is short/sequential/guessable; intake_token
 * is a long random one-time value safe to put in a link).
 *
 * RESPONSE BEHAVIOUR: unchanged — 200 on a match, 404 (not an error) on an
 * unknown/expired token, so the form falls back to blank editable fields.
 *
 * ENVIRONMENT VARIABLES NEEDED: SUPABASE_URL, SUPABASE_SERVICE_KEY.
 */

const { selectByColumn } = require('./_lib/supabase-rest');

exports.handler = async function handler(event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const params = (event.queryStringParameters) || {};
  const token = params.token;

  if (!token) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Missing token query parameter' }) };
  }

  let orderRows;
  try {
    orderRows = await selectByColumn('orders', 'intake_token', token);
  } catch (err) {
    console.error('get-intake-prefill: Supabase lookup failed:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Lookup failure' }) };
  }

  const order = orderRows[0];
  if (!order) {
    // Unknown token: let the caller fall back to a blank form.
    return { statusCode: 404, body: JSON.stringify({ ok: false, error: 'Unknown or expired token' }) };
  }

  let contactRows;
  try {
    contactRows = await selectByColumn('client_contacts', 'id', order.client_contact_id);
  } catch (err) {
    console.error('get-intake-prefill: Supabase client_contacts lookup failed:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Lookup failure' }) };
  }
  const contact = contactRows[0];
  if (!contact) {
    // The order's own referential integrity is broken (should not happen —
    // client_contact_id is a foreign key) — fail safe rather than return a
    // half-populated prefill.
    console.error('get-intake-prefill: order', order.id, 'has no matching client_contacts row');
    return { statusCode: 404, body: JSON.stringify({ ok: false, error: 'Unknown or expired token' }) };
  }

  // Same safe, form-relevant subset as before — never anything beyond it.
  const prefill = {
    clientId: order.order_ref,
    firstName: contact.first_name,
    lastName: contact.last_name,
    email: contact.email,
    mobile: contact.mobile,
    addrStreet: contact.addr_street,
    addrSuburb: contact.addr_suburb,
    addrState: contact.addr_state,
    addrPostcode: contact.addr_postcode,
  };

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(prefill),
  };
};