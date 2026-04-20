/**
 * GeneThrive — Milestone Payment Release
 * ─────────────────────────────────────────────────────────────────────────────
 * Netlify Function: netlify/functions/release-payment.js
 *
 * TRIGGERED BY: Ops team via the admin-dispatch page milestone buttons
 *
 * MILESTONES:
 *   pickup  → transfers $140 to pharmacist (client collected vitamins)
 *   cil     → transfers $65 to naturopath (CIL consultation completed)
 *
 * WHAT IT DOES:
 *   1. Verifies the ops token (same OPS_ADMIN_TOKEN as admin-trigger.js)
 *   2. Validates the milestone type and client ID
 *   3. Checks the milestone hasn't already been released (idempotency)
 *   4. Transfers the correct amount to the correct Stripe Connected Account
 *   5. Tags the Shopify order so the milestone is recorded
 *   6. Notifies ops by email confirming the release
 *
 * CALLED FROM: admin-dispatch.html milestone buttons (we'll add these)
 *   POST /.netlify/functions/release-payment
 *   Header: X-Ops-Token: <OPS_ADMIN_TOKEN>
 *   Body: { "clientId": "GT-1042-a3f9", "milestone": "pickup" | "cil" }
 *
 * ENVIRONMENT VARIABLES:
 *   OPS_ADMIN_TOKEN            = same token used by admin-trigger.js
 *   STRIPE_SECRET_KEY          = sk_test_xxxx or sk_live_xxxx
 *   STRIPE_ACCOUNT_PHARMACIST  = acct_xxxx
 *   STRIPE_ACCOUNT_NATUROPATH  = acct_xxxx
 *   SHOPIFY_STORE_DOMAIN       = your-store.myshopify.com
 *   SHOPIFY_ADMIN_TOKEN        = shpat_xxxx
 *   SMTP_HOST / PORT / USER / PASS
 *   EMAIL_FROM
 *   EMAIL_OPS
 *   EMAIL_REPLY_TO
 * ─────────────────────────────────────────────────────────────────────────────
 */

const Stripe     = require('stripe');
const nodemailer = require('nodemailer');

// ── Milestone config ──────────────────────────────────────────────────────────

const MILESTONES = {
  pickup: {
    label:       'Client pickup confirmed',
    amount:      14000, // $140.00 in cents
    amountLabel: '$140.00',
    recipient:   'Pharmacist',
    envKey:      'STRIPE_ACCOUNT_PHARMACIST',
    orderTag:    'pharmacist-paid',
    description: 'GeneThrive — pharmacist compounding fee (pickup confirmed)',
  },
  cil: {
    label:       'CIL consultation completed',
    amount:      6500, // $65.00 in cents
    amountLabel: '$65.00',
    recipient:   'Naturopath',
    envKey:      'STRIPE_ACCOUNT_NATUROPATH',
    orderTag:    'naturopath-paid',
    description: 'GeneThrive — naturopath CIL consultation fee',
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function createTransporter() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587', 10),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

async function getShopifyOrder(clientId) {
  const res = await fetch(
    `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/orders.json` +
    `?tag=client-id:${encodeURIComponent(clientId)}&status=any&limit=1`,
    {
      headers: {
        'Content-Type':           'application/json',
        'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
      },
    }
  );
  const data = await res.json();
  return data.orders?.[0] || null;
}

async function tagShopifyOrder(orderId, existingTags, newTag) {
  const tags = existingTags
    ? [...new Set([...existingTags.split(', '), newTag])].join(', ')
    : newTag;

  await fetch(
    `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/orders/${orderId}.json`,
    {
      method: 'PUT',
      headers: {
        'Content-Type':           'application/json',
        'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
      },
      body: JSON.stringify({ order: { id: orderId, tags } }),
    }
  );
}

// ── Main handler ──────────────────────────────────────────────────────────────

exports.handler = async function (event) {

  const corsHeaders = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Ops-Token',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: 'Method not allowed' };
  }

  // 1. Verify ops token
  const opsToken = event.headers['x-ops-token'];
  if (!opsToken || opsToken !== process.env.OPS_ADMIN_TOKEN) {
    console.warn('GeneThrive release-payment: invalid or missing ops token');
    return {
      statusCode: 401,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Unauthorized' }),
    };
  }

  // 2. Parse and validate request body
  let clientId, milestone;
  try {
    const body = JSON.parse(event.body);
    clientId   = body.clientId?.trim();
    milestone  = body.milestone?.trim().toLowerCase();
  } catch {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    };
  }

  if (!clientId) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Missing clientId' }),
    };
  }

  if (!MILESTONES[milestone]) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({
        error: `Invalid milestone "${milestone}". Must be "pickup" or "cil"`,
      }),
    };
  }

  const config = MILESTONES[milestone];
  console.log(`GeneThrive: Release payment — ${config.label} for ${clientId}`);

  // 3. Look up the Shopify order to verify client ID and check idempotency
  let order;
  try {
    order = await getShopifyOrder(clientId);
  } catch (err) {
    console.error('GeneThrive: Shopify lookup failed —', err.message);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Failed to look up order in Shopify' }),
    };
  }

  if (!order) {
    return {
      statusCode: 404,
      headers: corsHeaders,
      body: JSON.stringify({ error: `No order found for client ID: ${clientId}` }),
    };
  }

  // 4. Idempotency check — don't release the same milestone twice
  const existingTags = order.tags || '';
  if (existingTags.includes(config.orderTag)) {
    console.warn(`GeneThrive: Milestone "${milestone}" already released for ${clientId}`);
    return {
      statusCode: 409,
      headers: corsHeaders,
      body: JSON.stringify({
        error:    `Milestone "${milestone}" has already been released for ${clientId}`,
        alreadyReleased: true,
      }),
    };
  }

  // 5. Transfer via Stripe Connect
  const stripe             = Stripe(process.env.STRIPE_SECRET_KEY);
  const destinationAccount = process.env[config.envKey];

  if (!destinationAccount) {
    console.error(`GeneThrive: Missing env var ${config.envKey}`);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: `Stripe account not configured for ${config.recipient}` }),
    };
  }

  let transfer;
  try {
    transfer = await stripe.transfers.create({
      amount:      config.amount,
      currency:    'aud',
      destination: destinationAccount,
      description: config.description,
      metadata: {
        clientId,
        milestone,
        shopifyOrderId: String(order.id),
      },
    });
    console.log(`GeneThrive: Stripe transfer ${transfer.id} — ${config.amountLabel} to ${config.recipient} for ${clientId}`);
  } catch (err) {
    console.error(`GeneThrive: Stripe transfer failed —`, err.message);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: `Stripe transfer failed: ${err.message}` }),
    };
  }

  // 6. Tag the Shopify order to record the milestone
  try {
    await tagShopifyOrder(order.id, existingTags, config.orderTag);
    console.log(`GeneThrive: Order ${order.order_number} tagged "${config.orderTag}"`);
  } catch (err) {
    console.warn('GeneThrive: Order tagging failed —', err.message);
    // Non-critical — transfer already went through
  }

  // 7. Send ops confirmation email
  try {
    const transporter = createTransporter();
    await transporter.sendMail({
      from:    process.env.EMAIL_FROM,
      to:      process.env.EMAIL_OPS,
      replyTo: process.env.EMAIL_REPLY_TO,
      subject: `Payment released — ${config.recipient} ${config.amountLabel} — ${clientId}`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;color:#1c1c1a">
          <div style="background:#1c1c1a;padding:16px 24px;border-radius:8px 8px 0 0">
            <span style="color:#fff;font-size:15px;font-weight:600;letter-spacing:2px">GENETHRIVE</span>
            <span style="color:rgba(255,255,255,0.5);font-size:12px;margin-left:10px">Payment Release</span>
          </div>
          <div style="border:1px solid #d6cfc3;border-top:none;padding:24px;border-radius:0 0 8px 8px">
            <p style="margin:0 0 16px;font-size:14px">Milestone payment successfully released.</p>
            <table style="width:100%;font-size:13px;border-collapse:collapse">
              <tr style="border-bottom:1px solid #ede8df">
                <td style="padding:8px 0;color:#7a7a74;width:140px">Client ID</td>
                <td style="padding:8px 0;font-weight:600">${clientId}</td>
              </tr>
              <tr style="border-bottom:1px solid #ede8df">
                <td style="padding:8px 0;color:#7a7a74">Milestone</td>
                <td style="padding:8px 0">${config.label}</td>
              </tr>
              <tr style="border-bottom:1px solid #ede8df">
                <td style="padding:8px 0;color:#7a7a74">Recipient</td>
                <td style="padding:8px 0">${config.recipient}</td>
              </tr>
              <tr style="border-bottom:1px solid #ede8df">
                <td style="padding:8px 0;color:#7a7a74">Amount</td>
                <td style="padding:8px 0;font-weight:600;color:#166534">${config.amountLabel}</td>
              </tr>
              <tr style="border-bottom:1px solid #ede8df">
                <td style="padding:8px 0;color:#7a7a74">Stripe transfer</td>
                <td style="padding:8px 0;font-family:monospace;font-size:12px">${transfer.id}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;color:#7a7a74">Shopify order</td>
                <td style="padding:8px 0">#${order.order_number}</td>
              </tr>
            </table>
            <p style="margin:16px 0 0;font-size:12px;color:#7a7a74">
              This transfer has been recorded on the Shopify order and is visible in your Stripe dashboard.
            </p>
          </div>
        </div>
      `,
    });
  } catch (err) {
    console.warn('GeneThrive: Ops notification email failed —', err.message);
    // Non-critical
  }

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({
      success:    true,
      clientId,
      milestone,
      recipient:  config.recipient,
      amount:     config.amountLabel,
      transferId: transfer.id,
      message:    `${config.amountLabel} successfully transferred to ${config.recipient}`,
    }),
  };
};
