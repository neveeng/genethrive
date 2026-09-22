/**
 * GeneThrive — Finalise Order
 * ─────────────────────────────────────────────────────────────────────────────
 * Netlify Function: netlify/functions/finalise-order.js
 *
 * CALLED BY: page.payment.liquid AFTER stripe.confirmCardPayment() succeeds
 *
 * WHAT IT DOES:
 *   1. Validates env vars and verifies PaymentIntent is paid
 *   2. Generates Client ID: GT-{random}-{hash}
 *   3. Transfers $137.50 to NutriPath via Stripe Connect (1st half — kit dispatch)
 *   4. Creates $200/month Stripe Subscription on the saved card
 *   5. Creates a Shopify order + customer record
 *   6. Creates order_sla row in Supabase
 *   7. Emails client (confirmation + health profile link) + ops (status only)
 *   8. SMS client with health profile link
 *   9. Returns clientId to the browser
 *
 * PRIVACY:
 *   - Health data is NOT collected here — it comes later via submit-health-profile.js
 *   - No health content is sent to Shopify, ops email, or anywhere except Supabase
 *   - Ops email is status-only (client ID, order number, payment status)
 *
 * ENVIRONMENT VARIABLES REQUIRED:
 *   STRIPE_SECRET_KEY            sk_live_... (or sk_test_... in test mode)
 *   STRIPE_ACCOUNT_NUTRIPATH     acct_... (Stripe Connect)
 *   STRIPE_PRICE_MONTHLY         price_... (recurring $200/mo product)
 *   PRICE_NUTRIPATH_1_CENTS      13750 ($137.50 — 1st NutriPath payment)
 *   SHOPIFY_STORE_DOMAIN         YourWebsite.myshopify.com
 *   SHOPIFY_ADMIN_TOKEN          shpat_...
 *   SUPABASE_URL                 https://xxx.supabase.co
 *   SUPABASE_SERVICE_KEY         service_role key (NOT anon)
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
 *   EMAIL_FROM                   GeneThrive <no-reply@genethrive.com.au>
 *   EMAIL_OPS                    Paul's email
 *   EMAIL_REPLY_TO               hello@genethrive.com.au
 *   SINCH_API_KEY                from Sinch portal (for SMS)
 *   SINCH_API_SECRET             from Sinch portal
 *   SINCH_SENDER_ID              GeneThrive (or provisioned number)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const Stripe     = require('stripe');
const crypto     = require('crypto');
const nodemailer = require('nodemailer');
const { shopifyFetch } = require('./shopify-token');
const { sendSmsSafe, formatAustralianPhone } = require('./sinch-sms');

// ── Supabase REST helper ──────────────────────────────────────────────────────

async function supabaseRequest(path, method = 'GET', body = null) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: {
      'Content-Type':  'application/json',
      'apikey':        process.env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Prefer':        method === 'POST' ? 'return=minimal' : '',
    },
    body: body ? JSON.stringify(body) : null,
  });
  return { ok: res.ok, status: res.status };
}

// ── Env var validation ────────────────────────────────────────────────────────

function validateEnv() {
  const required = [
    'STRIPE_SECRET_KEY',
    'SHOPIFY_STORE_DOMAIN', 'SHOPIFY_ADMIN_TOKEN',
    'SUPABASE_URL', 'SUPABASE_SERVICE_KEY',
    'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS',
    'EMAIL_FROM', 'EMAIL_OPS', 'EMAIL_REPLY_TO',
  ];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    console.error('GeneThrive: Missing env vars —', missing.join(', '));
    return false;
  }
  if (!process.env.STRIPE_ACCOUNT_NUTRIPATH) console.warn('GeneThrive: STRIPE_ACCOUNT_NUTRIPATH not set — NutriPath transfer will be skipped');
  if (!process.env.STRIPE_PRICE_MONTHLY)     console.warn('GeneThrive: STRIPE_PRICE_MONTHLY not set — subscription will be skipped');
  return true;
}

// ── Client ID ────────────────────────────────────────────────────────────────

function generateClientId(paymentIntentId) {
  const hash = crypto
    .createHash('sha256')
    .update(paymentIntentId)
    .digest('hex')
    .slice(0, 6);
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `GT-${rand}-${hash}`;
}

// ── Email transporter ─────────────────────────────────────────────────────────

function createTransporter() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587', 10),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────

exports.handler = async function (event) {

  const corsHeaders = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST')   return { statusCode: 405, headers: corsHeaders, body: 'Method not allowed' };

  if (!validateEnv()) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Server configuration error — check Netlify logs' }),
    };
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

  // Parse request — health data is NOT expected here
  let paymentIntentId, clientDetails;
  try {
    const body      = JSON.parse(event.body);
    paymentIntentId = body.paymentIntentId;
    clientDetails   = body.clientDetails;   // { name, email, phone, address, suburb, state, postcode }
  } catch {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  if (!paymentIntentId || !clientDetails?.email) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing paymentIntentId or clientDetails' }) };
  }

  // ── 1. Verify payment succeeded ─────────────────────────────────────────────
  let paymentIntent;
  try {
    paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    console.log(`GeneThrive: PaymentIntent status — ${paymentIntent.status}`);
    if (paymentIntent.status !== 'succeeded') {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: `Payment not confirmed. Status: ${paymentIntent.status}` }),
      };
    }
  } catch (err) {
    console.error('GeneThrive: PaymentIntent verification failed —', err.message);
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Could not verify payment' }) };
  }

  const stripeCustomerId = paymentIntent.customer;
  const clientId         = generateClientId(paymentIntentId);
  const orderDate        = new Date().toLocaleDateString('en-AU', { day: '2-digit', month: 'long', year: 'numeric' });

  console.log(`GeneThrive: Finalising order — Client ID ${clientId}`);

  // ── 2. Transfer $137.50 to NutriPath (1st half — for kit dispatch) ───────────
  // 2nd half ($137.50) released by nutripath-submit.js when DNA results are uploaded.
  if (process.env.STRIPE_ACCOUNT_NUTRIPATH) {
    try {
      const t = await stripe.transfers.create({
        amount:      parseInt(process.env.PRICE_NUTRIPATH_1_CENTS || '13750'),
        currency:    'aud',
        destination: process.env.STRIPE_ACCOUNT_NUTRIPATH,
        description: `GeneThrive ${clientId} — DNA lab payment (1st half — kit dispatch)`,
        metadata:    { clientId, stage: 'kit-dispatch' },
      });
      console.log(`GeneThrive: $137.50 transferred to NutriPath — ${t.id}`);
    } catch (err) {
      console.error('GeneThrive: NutriPath 1st transfer failed —', err.message);
    }
  }

  // ── 3. Create $200/month subscription ────────────────────────────────────────
  let subscriptionId = null;
  if (process.env.STRIPE_PRICE_MONTHLY && stripeCustomerId) {
    try {
      const paymentMethod = paymentIntent.payment_method;

      try {
        await stripe.paymentMethods.attach(paymentMethod, { customer: stripeCustomerId });
      } catch (attachErr) {
        if (!attachErr.message.includes('already been attached')) throw attachErr;
      }

      await stripe.customers.update(stripeCustomerId, {
        invoice_settings: { default_payment_method: paymentMethod },
        metadata: { clientId },
      });

      const subscription = await stripe.subscriptions.create({
        customer:          stripeCustomerId,
        items:             [{ price: process.env.STRIPE_PRICE_MONTHLY }],
        trial_period_days: 30,
        metadata:          { clientId, product: 'GeneThrive Monthly Vitamins' },
      });

      subscriptionId = subscription.id;
      console.log(`GeneThrive: Subscription created — ${subscriptionId}`);
    } catch (err) {
      console.error('GeneThrive: Subscription creation failed —', err.message);
    }
  }

  // ── 4. Create Shopify order ──────────────────────────────────────────────────
  // NOTE: health data is NOT stored in Shopify — it goes to Supabase via submit-health-profile.js
  let shopifyOrderNumber = null;
  let shopifyOrderId     = null;
  try {
    const nameParts = clientDetails.name.split(' ');
    const firstName = nameParts[0];
    const lastName  = nameParts.slice(1).join(' ') || '.';

    const shopifyRes = await shopifyFetch('/admin/api/2024-01/orders.json', {
      method: 'POST',
      body: JSON.stringify({
        order: {
          email:                    clientDetails.email,
          financial_status:         'paid',
          fulfillment_status:       null,
          send_receipt:             false,
          send_fulfillment_receipt: false,
          tags:                     `stripe-managed,client-id:${clientId},awaiting-health-profile`,
          note:                     `Stripe PI: ${paymentIntentId} | Sub: ${subscriptionId || 'pending'}`,
          line_items: [{
            title:             'GeneThrive DNA + First Month Vitamins',
            quantity:          1,
            price:             '549.00',
            requires_shipping: false,
          }],
          billing_address: {
            first_name: firstName,
            last_name:  lastName,
            address1:   clientDetails.address,
            city:       clientDetails.suburb,
            province:   clientDetails.state,
            zip:        clientDetails.postcode,
            country:    'AU',
            phone:      clientDetails.phone,
          },
          shipping_address: {
            first_name: firstName,
            last_name:  lastName,
            address1:   clientDetails.address,
            city:       clientDetails.suburb,
            province:   clientDetails.state,
            zip:        clientDetails.postcode,
            country:    'AU',
            phone:      clientDetails.phone,
          },
        },
      }),
    });

    const shopifyText = await shopifyRes.text();
    let shopifyData;
    try { shopifyData = JSON.parse(shopifyText); }
    catch { throw new Error(`Non-JSON from Shopify: ${shopifyText.slice(0, 200)}`); }

    if (!shopifyRes.ok) {
      console.error('GeneThrive: Shopify order error —', JSON.stringify(shopifyData.errors || shopifyData));
    } else {
      shopifyOrderNumber = shopifyData.order?.order_number;
      shopifyOrderId     = shopifyData.order?.id;
      console.log(`GeneThrive: Shopify order #${shopifyOrderNumber} created for ${clientId}`);
    }
  } catch (err) {
    console.error('GeneThrive: Shopify order creation failed —', err.message);
  }

  // ── 4b. Create / update Shopify customer ─────────────────────────────────────
  try {
    const nameParts = clientDetails.name.split(' ');
    const firstName = nameParts[0];
    const lastName  = nameParts.slice(1).join(' ') || '.';

    const accountRes  = await shopifyFetch('/admin/api/2024-01/customers.json', {
      method: 'POST',
      body: JSON.stringify({
        customer: {
          first_name:         firstName,
          last_name:          lastName,
          email:              clientDetails.email,
          phone:              clientDetails.phone,
          send_email_invite:  false,
          send_email_welcome: false,
          tags:               `client-id:${clientId},genethrive-member`,
          note:               `Client ID: ${clientId} | Stripe PI: ${paymentIntentId}`,
          addresses: [{
            address1:   clientDetails.address,
            city:       clientDetails.suburb,
            province:   clientDetails.state,
            zip:        clientDetails.postcode,
            country:    'AU',
            phone:      clientDetails.phone,
            first_name: firstName,
            last_name:  lastName,
            default:    true,
          }],
        },
      }),
    });

    const accountData = await accountRes.json();

    if (!accountRes.ok && accountData.errors?.email) {
      // Email already exists — just add the client ID tag
      const existingRes  = await shopifyFetch(
        `/admin/api/2024-01/customers/search.json?query=email:${encodeURIComponent(clientDetails.email)}&limit=1`
      );
      const existingData = await existingRes.json();
      const existing     = existingData.customers?.[0];
      if (existing) {
        const tags = existing.tags ? existing.tags.split(', ') : [];
        if (!tags.includes(`client-id:${clientId}`)) {
          tags.push(`client-id:${clientId}`);
          await shopifyFetch(`/admin/api/2024-01/customers/${existing.id}.json`, {
            method: 'PUT',
            body:   JSON.stringify({ customer: { id: existing.id, tags: tags.join(', ') } }),
          });
        }
        console.log(`GeneThrive: Existing Shopify customer updated — ${clientId}`);
      }
    } else {
      console.log(`GeneThrive: Shopify customer created — ${clientId}`);
    }
  } catch (err) {
    console.error('GeneThrive: Customer creation error (non-fatal) —', err.message);
  }

  // ── 5. Create Supabase order_sla record ──────────────────────────────────────
  try {
    const result = await supabaseRequest('/order_sla', 'POST', {
      client_id:            clientId,
      shopify_order_number: shopifyOrderNumber ? String(shopifyOrderNumber) : null,
      client_email:         clientDetails.email,
      client_phone:         clientDetails.phone,
      payment_received_at:  new Date().toISOString(),
      current_stage:        'health_profile',
      stage_entered_at:     new Date().toISOString(),
    });
    if (!result.ok) console.error('GeneThrive: Supabase order_sla insert failed — status', result.status);
    else console.log(`GeneThrive: Supabase order_sla created — ${clientId}`);
  } catch (err) {
    console.error('GeneThrive: Supabase order_sla insert failed —', err.message);
  }

  // ── 6. Build URLs ─────────────────────────────────────────────────────────────
  const storeUrl  = `https://${process.env.SHOPIFY_STORE_DOMAIN}`;
  const healthUrl = `${storeUrl}/pages/health-profile?id=${encodeURIComponent(clientId)}`;

  // ── 7. Send emails ────────────────────────────────────────────────────────────
  // PRIVACY RULE:
  //   - Client email: confirmation + health profile link
  //   - Ops email: status only — NO health content, NO clinical data
  //   - NutriPath notified later by submit-health-profile.js (after profile is submitted)
  try {
    const transporter = createTransporter();
    const firstName   = clientDetails.name.split(' ')[0];
    const initialAmt  = ((parseInt(process.env.PRICE_INITIAL_CENTS || '54900')) / 100).toFixed(2);

    await Promise.all([

      // Client — payment confirmed + health profile link
      transporter.sendMail({
        from:    process.env.EMAIL_FROM,
        to:      clientDetails.email,
        replyTo: process.env.EMAIL_REPLY_TO,
        subject: `Your GeneThrive order is confirmed — next step inside — ${clientId}`,
        html: `
          <div style="font-family:sans-serif;color:#1c1c1a;max-width:520px">
            <div style="background:#4a6741;padding:20px 24px;border-radius:8px 8px 0 0">
              <span style="color:#fff;font-size:16px;font-weight:600;letter-spacing:2px">GENETHRIVE</span>
            </div>
            <div style="border:1px solid #d6cfc3;border-top:none;padding:28px;border-radius:0 0 8px 8px">
              <h2 style="margin:0 0 14px;font-size:20px">Thank you, ${firstName}!</h2>
              <p style="margin:0 0 16px;font-size:14px;color:#4a4a46;line-height:1.6">
                Your payment of <strong>$${initialAmt}</strong> has been received.
              </p>
              <div style="background:#e8eee7;border-radius:8px;padding:16px;margin-bottom:20px">
                <div style="font-size:10px;color:#4a6741;font-weight:600;letter-spacing:1px;margin-bottom:4px">YOUR REFERENCE</div>
                <div style="font-size:18px;font-weight:700">${clientId}</div>
                <div style="font-size:12px;color:#7a7a74;margin-top:4px">Keep this for any enquiries</div>
              </div>
              <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:20px;margin-bottom:20px">
                <div style="font-size:13px;font-weight:600;color:#92400e;margin-bottom:8px">
                  Action required — complete your health profile
                </div>
                <p style="font-size:13px;color:#4a4a46;line-height:1.6;margin:0 0 14px">
                  To personalise your vitamin formula and dispatch your DNA swab kit,
                  we need a few health details. It takes about 2 minutes.
                </p>
                <a href="${healthUrl}"
                   style="display:inline-block;padding:12px 24px;background:#4a6741;color:#fff;
                          border-radius:8px;font-size:14px;font-weight:500;text-decoration:none">
                  Complete your health profile →
                </a>
              </div>
              <p style="font-size:13px;font-weight:600;margin:0 0 10px">What happens next:</p>
              <ol style="font-size:13px;color:#4a4a46;line-height:1.8;margin:0 0 20px;padding-left:18px">
                <li><strong>Complete your health profile</strong> — link above</li>
                <li>DNA swab kit dispatched to your address (3–5 business days)</li>
                <li>Return the swab using the prepaid envelope</li>
                <li>Our naturopath reviews your DNA results</li>
                <li>Your personalised vitamins are compounded and dispatched</li>
                <li>Your <strong>$200/month</strong> subscription begins 30 days from today</li>
              </ol>
              <p style="font-size:12px;color:#7a7a74;margin:0 0 8px">
                To cancel your subscription visit
                <a href="${storeUrl}/pages/cancel-subscription" style="color:#4a6741">our cancellation page</a>.
              </p>
              <p style="font-size:12px;color:#7a7a74;margin:0">
                Questions? <a href="mailto:${process.env.EMAIL_REPLY_TO}" style="color:#4a6741">${process.env.EMAIL_REPLY_TO}</a>
              </p>
            </div>
          </div>
        `,
      }),

      // Ops — status only, NO health content
      transporter.sendMail({
        from:    process.env.EMAIL_FROM,
        to:      process.env.EMAIL_OPS,
        replyTo: process.env.EMAIL_REPLY_TO,
        subject: `New order — ${clientId} — awaiting health profile`,
        html: `
          <div style="font-family:sans-serif;max-width:480px;color:#1c1c1a">
            <div style="background:#1c1c1a;padding:16px 24px;border-radius:8px 8px 0 0">
              <span style="color:#fff;font-size:15px;font-weight:600;letter-spacing:2px">GENETHRIVE</span>
              <span style="color:rgba(255,255,255,0.5);font-size:12px;margin-left:10px">Ops — Status Only</span>
            </div>
            <div style="border:1px solid #d6cfc3;border-top:none;padding:24px;border-radius:0 0 8px 8px">
              <p style="font-size:14px;margin:0 0 16px;color:#4a4a46">
                New order paid. Client sent health profile link.
                NutriPath notified after profile is submitted.
              </p>
              <table style="width:100%;font-size:13px;border-collapse:collapse">
                <tr style="border-bottom:1px solid #ede8df">
                  <td style="padding:8px 0;color:#7a7a74;width:160px">Client ID</td>
                  <td style="padding:8px 0;font-weight:600">${clientId}</td>
                </tr>
                <tr style="border-bottom:1px solid #ede8df">
                  <td style="padding:8px 0;color:#7a7a74">Shopify order</td>
                  <td style="padding:8px 0">${shopifyOrderNumber ? '#' + shopifyOrderNumber : 'Pending'}</td>
                </tr>
                <tr style="border-bottom:1px solid #ede8df">
                  <td style="padding:8px 0;color:#7a7a74">Stripe subscription</td>
                  <td style="padding:8px 0;font-family:monospace;font-size:11px">${subscriptionId || 'Pending'}</td>
                </tr>
                <tr style="border-bottom:1px solid #ede8df">
                  <td style="padding:8px 0;color:#7a7a74">NutriPath 1st payment</td>
                  <td style="padding:8px 0;color:#166534;font-weight:500">$137.50 released</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;color:#7a7a74">Stage</td>
                  <td style="padding:8px 0;color:#92400e;font-weight:500">Awaiting health profile</td>
                </tr>
              </table>
              <p style="font-size:11px;color:#7a7a74;margin:16px 0 0;font-style:italic">
                Health data is stored securely in Supabase (Barbara-only access) — not included here.
              </p>
            </div>
          </div>
        `,
      }),

    ]);

    console.log(`GeneThrive: Emails sent — ${clientId}`);
  } catch (err) {
    console.error('GeneThrive: Email sending failed —', err.message);
  }

  // ── 8. SMS client with health profile link (non-fatal) ───────────────────────
  if (clientDetails.phone) {
    const e164 = formatAustralianPhone(clientDetails.phone);
    await sendSmsSafe(
      e164,
      `GeneThrive: Payment confirmed! Your reference: ${clientId}. ` +
      `Complete your health profile to get started: ${healthUrl}`,
      `order ${clientId}`
    );
    console.log(`GeneThrive: SMS sent to client — ${clientId}`);
  }

  // ── 9. Return to browser ──────────────────────────────────────────────────────
  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({
      success:      true,
      clientId,
      shopifyOrder: shopifyOrderNumber,
      subscription: subscriptionId,
    }),
  };
};