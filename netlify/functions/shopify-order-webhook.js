/**
 * GeneThrive — Shopify order webhook: Shopify order paid -> new order in the
 * LOCKED schema (client_contacts + orders + status_events + sla_clocks)
 * =============================================================================
 *
 * WHAT CHANGED IN THIS RECONCILIATION
 *   This function used to write one row into an ad hoc `clients` table
 *   invented this week (see CHANGELOG.md for the full reasoning). It now
 *   writes into the REAL, Paul-approved schema (supabase_schema.sql, locked
 *   11 Sep 2026):
 *     1. Find-or-create a `client_contacts` row (checkout identity/address —
 *        never clinical) for this email.
 *     2. Create a new `orders` row for this Shopify order, with a fresh
 *        one-time `intake_token` — see "WHERE THE INTAKE TOKEN LIVES NOW"
 *        below for why this moved from the old clients table onto orders.
 *     3. Insert a `status_events` row with step_key = 'order.paid' — the
 *        first entry in the pipeline the client_pipeline view (and the
 *        already-built Chain Oversight dashboard reading it) derives
 *        current_stage from.
 *     4. Insert an `sla_clocks` row for 'kit_dispatch_48h', started at the
 *        same paid_at timestamp — per checklist §6, this SLA starts at
 *        order.paid directly.
 *   All four writes happen in sequence (not a single DB transaction — see
 *   "NOT ATOMIC" note below), matching PostgREST's per-request model.
 *
 * WHERE THE INTAKE TOKEN LIVES NOW
 *   The old ad hoc schema put `intake_token` on the `clients` row itself. The
 *   locked schema doesn't have a `clients` table at all — a person is
 *   `client_contacts` (identity) and each of their purchases is a separate
 *   `orders` row. A one-time intake link genuinely belongs to ONE order, not
 *   to the person forever: if this client resubscribes next year, that new
 *   order needs its OWN fresh, single-use token, while an old token from a
 *   previous order should not still work. So `intake_token` /
 *   `intake_token_created_at` live on `orders` (see supabase_schema.sql).
 *
 * NOT ATOMIC (documented, not hidden)
 *   A real Postgres transaction across four PostgREST calls isn't possible
 *   over plain REST without an RPC/stored procedure. If this function dies
 *   between steps, Shopify's own webhook retry (it retries any non-2xx
 *   response) will call this function again — and because Shopify's
 *   `X-Shopify-Order-Id` uniquely identifies the same order, a production
 *   version should look up an existing order by `shopify_order_id` first and
 *   skip re-creating it, the same idempotency guard the OLD function's
 *   comment already flagged as a nice-to-have. That idempotency guard is not
 *   implemented here (kept out of scope, exactly as it was in the version
 *   this replaces) — flagged in CHANGELOG.md's "Unverified" list, not
 *   silently assumed away. A real Supabase deployment should wrap steps
 *   2–4 in a single `plpgsql` RPC function for true atomicity.
 *
 * WHICH SHOPIFY EVENT ("TOPIC") THIS IS FOR: orders/paid (unchanged reasoning
 * — see the original comment block, preserved below).
 *
 * VERIFYING THE REQUEST IS REALLY FROM SHOPIFY (HMAC): unchanged — see below.
 *
 * ENVIRONMENT VARIABLES THIS FUNCTION NEEDS (set in Netlify site settings)
 *   SHOPIFY_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_KEY.
 */

const crypto = require('crypto');
const { selectByColumn, insertRow } = require('./_lib/supabase-rest');

// ---------------------------------------------------------------------------
// order_ref ("GT-2026-NNNN") generation — unchanged reasoning from the
// original function: a timestamp/random suffix is good enough for a
// low-volume subscription business; a true collision is rejected outright by
// the `orders.order_ref` UNIQUE constraint rather than silently overwriting.
// ---------------------------------------------------------------------------
function generateOrderRef() {
  const year = new Date().getFullYear();
  const suffix = crypto.randomInt(0, 10000).toString().padStart(4, '0');
  return 'GT-' + year + '-' + suffix;
}

function generateIntakeToken() {
  return crypto.randomBytes(24).toString('hex');
}

function isValidShopifySignature(rawBody, hmacHeader) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret || !hmacHeader) return false;
  const computed = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  const a = Buffer.from(computed);
  const b = Buffer.from(hmacHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function extractCustomerFields(order) {
  const customer = order.customer || {};
  const shipping = order.shipping_address || {};
  return {
    first_name: shipping.first_name || customer.first_name || '',
    last_name: shipping.last_name || customer.last_name || '',
    email: order.email || customer.email || '',
    mobile: shipping.phone || customer.phone || order.phone || '',
    addr_street: [shipping.address1, shipping.address2].filter(Boolean).join(' ').trim(),
    addr_suburb: shipping.city || '',
    addr_state: shipping.province_code || shipping.province || '',
    addr_postcode: shipping.zip || '',
  };
}

function extractSubscriptionSku(order) {
  const items = Array.isArray(order.line_items) ? order.line_items : [];
  const first = items[0] || {};
  return first.sku || first.variant_id ? String(first.sku || first.variant_id) : null;
}

exports.handler = async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const rawBody = event.body || '';
  const hmacHeader =
    (event.headers && (event.headers['x-shopify-hmac-sha256'] || event.headers['X-Shopify-Hmac-Sha256'])) || '';

  if (!isValidShopifySignature(rawBody, hmacHeader)) {
    return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Invalid Shopify signature' }) };
  }

  let order;
  try {
    order = JSON.parse(rawBody);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Invalid JSON body' }) };
  }

  const fields = extractCustomerFields(order);
  let orderRef;

  try {
    // --- 1. find-or-create the client_contacts row ------------------------
    let contact = null;
    if (fields.email) {
      const existing = await selectByColumn('client_contacts', 'email', fields.email);
      contact = existing[0] || null;
    }
    if (!contact) {
      contact = await insertRow('client_contacts', {
        first_name: fields.first_name,
        last_name: fields.last_name,
        email: fields.email,
        mobile: fields.mobile,
        addr_street: fields.addr_street,
        addr_suburb: fields.addr_suburb,
        addr_state: fields.addr_state,
        addr_postcode: fields.addr_postcode,
      });
    }

    // --- 2. create the order, with a fresh intake token --------------------
    orderRef = generateOrderRef();
    const intakeToken = generateIntakeToken();
    const paidAt = new Date().toISOString();
    const newOrder = await insertRow('orders', {
      order_ref: orderRef,
      client_contact_id: contact.id,
      status: 'paid',
      paid_at: paidAt,
      subscription_sku: extractSubscriptionSku(order),
      intake_token: intakeToken,
      intake_token_created_at: paidAt,
    });

    // --- 3. status_events: order.paid --------------------------------------
    await insertRow('status_events', {
      order_id: newOrder.id,
      step_key: 'order.paid',
      actor_role: 'client',
      occurred_at: paidAt,
      meta: { shopify_order_id: String(order.id || order.order_number || '') },
    });

    // --- 4. sla_clocks: kit_dispatch_48h, starts at order.paid --------------
    const dueAt = new Date(new Date(paidAt).getTime() + 48 * 3600 * 1000).toISOString();
    await insertRow('sla_clocks', {
      order_id: newOrder.id,
      clock_key: 'kit_dispatch_48h',
      started_at: paidAt,
      due_at: dueAt,
      state: 'green',
    });
  } catch (err) {
    // Shopify retries webhooks that don't return 2xx.
    console.error('shopify-order-webhook: failed to write to Supabase:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Storage failure' }) };
  }

  // TODO (future, not required for this task, unchanged from the original):
  // trigger the "here's your personal health profile link" email/SMS here,
  // e.g. https://YOURDOMAIN/intake?token=<intakeToken>&order=<orderRef>
  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, orderRef: orderRef }),
  };
};
