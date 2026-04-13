/**
 * GeneThrive — Guest-to-Customer Health Data Attachment
 * ─────────────────────────────────────────────────────────────────────────────
 * Netlify Function: netlify/functions/attach-guest-health-profile.js
 *
 * HOW IT WORKS:
 *   1. Guest client completes health form → data saved to order attributes
 *   2. Guest pays → Shopify creates order (health data is on the order)
 *   3. After checkout, Shopify prompts them to create an account
 *   4. When they create account → Shopify fires "customers/create" webhook
 *   5. This function catches that webhook, finds their most recent order,
 *      reads the health_* attributes, and writes them to their new
 *      customer profile as metafields — automatically, no manual work.
 *
 * SETUP STEPS:
 *   1. Deploy this file to Netlify (same project as save-health-profile.js)
 *   2. Your function URL will be:
 *        https://genethrive.netlify.app/netlify/functions/attach-guest-health-profile
 *   3. Register the webhook in Shopify:
 *        Shopify admin → Settings → Notifications → Webhooks
 *        → Create webhook:
 *            Event:   Customer creation
 *            Format:  JSON
 *            URL:     your function URL above
 *   4. Copy the webhook signing secret Shopify shows you and add it
 *      to your Netlify environment variables as:
 *        SHOPIFY_WEBHOOK_SECRET = whsec_xxxxxxxxxxxx
 *
 * ENVIRONMENT VARIABLES NEEDED (same .env as save-health-profile):
 *   SHOPIFY_STORE_DOMAIN    = your-store.myshopify.com
 *   SHOPIFY_ADMIN_TOKEN     = shpat_xxxxxxxxxxxxxxxxxxxx
 *   SHOPIFY_WEBHOOK_SECRET  = your webhook signing secret from Shopify
 * ─────────────────────────────────────────────────────────────────────────────
 */

const crypto = require('crypto');

// ── Health attribute keys we expect on the order ─────────────────────────────
const HEALTH_ATTRIBUTE_KEYS = [
  'health_pregnant_breastfeeding',
  'health_conditions',
  'health_conditions_detail',
  'health_medications',
  'health_medications_detail',
  'health_allergies',
  'health_allergies_detail',
  'health_gender',
  'health_fasting',
  'health_fasting_detail',
  'health_age',
];

// Map attribute key → Shopify metafield key + type
const METAFIELD_MAP = {
  health_pregnant_breastfeeding: { key: 'pregnant_breastfeeding', type: 'single_line_text_field' },
  health_conditions:             { key: 'conditions',             type: 'single_line_text_field' },
  health_conditions_detail:      { key: 'conditions_detail',      type: 'multi_line_text_field'  },
  health_medications:            { key: 'medications',            type: 'single_line_text_field' },
  health_medications_detail:     { key: 'medications_detail',     type: 'multi_line_text_field'  },
  health_allergies:              { key: 'allergies',              type: 'single_line_text_field' },
  health_allergies_detail:       { key: 'allergies_detail',       type: 'multi_line_text_field'  },
  health_gender:                 { key: 'gender',                 type: 'single_line_text_field' },
  health_fasting:                { key: 'fasting',                type: 'single_line_text_field' },
  health_fasting_detail:         { key: 'fasting_detail',         type: 'single_line_text_field' },
  health_age:                    { key: 'age',                    type: 'number_integer'         },
};

exports.handler = async function (event) {

  // ── 1. Only accept POST requests ─────────────────────────────────────────
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  // ── 2. Verify the request genuinely came from Shopify ────────────────────
  // Shopify signs every webhook with HMAC-SHA256. If verification fails,
  // someone is spoofing the webhook — reject immediately.
  const webhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error('GeneThrive: SHOPIFY_WEBHOOK_SECRET env var is not set');
    return { statusCode: 500, body: 'Server configuration error' };
  }

  const shopifyHmac   = event.headers['x-shopify-hmac-sha256'];
  const rawBody       = event.body;
  const computedHmac  = crypto
    .createHmac('sha256', webhookSecret)
    .update(rawBody, 'utf8')
    .digest('base64');

  if (computedHmac !== shopifyHmac) {
    console.warn('GeneThrive: Webhook HMAC verification failed — rejecting request');
    return { statusCode: 401, body: 'Unauthorized' };
  }

  // ── 3. Parse the customer payload from Shopify ───────────────────────────
  let customer;
  try {
    customer = JSON.parse(rawBody);
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const customerId    = customer.id;
  const customerEmail = customer.email;

  if (!customerId || !customerEmail) {
    return { statusCode: 400, body: 'Missing customer id or email' };
  }

  console.log(`GeneThrive: New customer created — ID ${customerId}, email ${customerEmail}`);

  const { SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_TOKEN } = process.env;

  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_TOKEN) {
    console.error('GeneThrive: Missing store domain or admin token env vars');
    return { statusCode: 500, body: 'Server configuration error' };
  }

  const headers = {
    'Content-Type':           'application/json',
    'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
  };

  // ── 4. Find their most recent order by email ─────────────────────────────
  // We search by email rather than customer ID because at the moment
  // the "customers/create" webhook fires, the order may still be linked
  // to the guest email rather than the new customer account.
  let orders;
  try {
    const ordersRes = await fetch(
      `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/orders.json` +
      `?email=${encodeURIComponent(customerEmail)}&status=any&limit=5`,
      { headers }
    );

    if (!ordersRes.ok) throw new Error(`Orders API returned ${ordersRes.status}`);
    const ordersData = await ordersRes.json();
    orders = ordersData.orders;
  } catch (err) {
    console.error('GeneThrive: Failed to fetch orders —', err.message);
    return { statusCode: 500, body: 'Failed to fetch orders' };
  }

  if (!orders || orders.length === 0) {
    console.log(`GeneThrive: No orders found for ${customerEmail} — skipping metafield attachment`);
    // Return 200 so Shopify doesn't keep retrying — this is expected for
    // customers who sign up without purchasing first.
    return { statusCode: 200, body: 'No orders found — nothing to attach' };
  }

  // Most recent order first
  const latestOrder = orders[0];
  const orderAttributes = latestOrder.note_attributes || [];

  console.log(`GeneThrive: Found order #${latestOrder.order_number} with ${orderAttributes.length} attributes`);

  // ── 5. Extract health_* attributes from the order ────────────────────────
  const healthData = {};
  for (const attr of orderAttributes) {
    if (HEALTH_ATTRIBUTE_KEYS.includes(attr.name)) {
      healthData[attr.name] = attr.value;
    }
  }

  if (Object.keys(healthData).length === 0) {
    console.log(`GeneThrive: No health attributes found on order #${latestOrder.order_number}`);
    return { statusCode: 200, body: 'No health data found on order — nothing to attach' };
  }

  console.log(`GeneThrive: Found ${Object.keys(healthData).length} health fields to attach to customer ${customerId}`);

  // ── 6. Write metafields to the new customer profile ──────────────────────
  const metafieldUrl = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/customers/${customerId}/metafields.json`;

  const saveResults = await Promise.allSettled(
    Object.entries(healthData).map(([attrKey, value]) => {
      const def = METAFIELD_MAP[attrKey];
      if (!def || value === null || value === undefined || String(value).trim() === '') return Promise.resolve(null);

      const finalValue = def.type === 'number_integer'
        ? String(parseInt(value, 10))
        : String(value).trim();

      return fetch(metafieldUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          metafield: {
            namespace: 'health',
            key:       def.key,
            value:     finalValue,
            type:      def.type,
          }
        }),
      }).then(async res => {
        const data = await res.json();
        if (!res.ok) throw new Error(JSON.stringify(data));
        return data;
      });
    })
  );

  const succeeded = saveResults.filter(r => r.status === 'fulfilled' && r.value !== null).length;
  const failed    = saveResults.filter(r => r.status === 'rejected');

  if (failed.length > 0) {
    failed.forEach(f => console.error('GeneThrive metafield error:', f.reason));
  }

  console.log(`GeneThrive: Attached ${succeeded} health metafields to customer ${customerId}`);

  // ── 7. Optionally tag the order so you know it's been processed ──────────
  // This adds a "health-profile-attached" tag to the order for easy
  // filtering in Shopify admin later.
  try {
    await fetch(
      `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/orders/${latestOrder.id}.json`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          order: {
            id:   latestOrder.id,
            tags: [latestOrder.tags, 'health-profile-attached'].filter(Boolean).join(', '),
          }
        }),
      }
    );
  } catch (err) {
    // Non-critical — don't fail the whole function if tagging fails
    console.warn('GeneThrive: Order tagging failed —', err.message);
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      success:    true,
      customerId,
      orderId:    latestOrder.id,
      saved:      succeeded,
      failed:     failed.length,
    }),
  };
};