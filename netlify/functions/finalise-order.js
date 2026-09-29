/**
 * GeneThrive — Finalise Order
 * ─────────────────────────────────────────────────────────────────────────────
 * Netlify Function: netlify/functions/finalise-order.js
 *
 * CALLED BY: page.payment.liquid AFTER stripe.confirmCardPayment() succeeds
 *
 * WHAT IT DOES:
 *   1. Validates env vars and verifies PaymentIntent is paid
 *   2. Generates order_ref (GT-2026-XXXX) and a random intake_token (UUID)
 *   3. Transfers $137.50 to NutriPath via Stripe Connect (1st half — kit dispatch)
 *   4. Creates $200/month Stripe Subscription on the saved card
 *   5. Creates a Shopify order + customer record
 *   6. Inserts client_contacts row in Supabase
 *   7. Inserts orders row in Supabase (with intake_token)
 *   8. Emails client (confirmation + personal health profile link) + ops (status only)
 *   9. SMS client with personal health profile link
 *  10. Returns orderRef (= clientId) to the browser
 *
 * PRIVACY:
 *   - Health data is NOT collected here — it comes later via submit-health-profile.js
 *   - The intake_token is a random UUID — safe to put in a URL, unlike order_ref
 *   - No health content is sent to Shopify, ops email, or anywhere except Supabase
 *   - Ops email is status-only (order_ref, Shopify order number, payment status)
 *   - intake_token is NOT included in the ops email — it's client-only
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
const { shopifyFetch }               = require('./_lib/shopify-token');
const { sendSmsSafe, formatAustralianPhone } = require('./_lib/sinch-sms');
const { insertRow }                  = require('./_lib/supabase-rest');

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

// ── Order ref: GT-2026-XXXXXX style ──────────────────────────────────────────
// 4-digit random + 2 hex chars = effectively unique for typical volumes.
// For production at scale you'd use a Supabase sequence instead.

function generateOrderRef() {
  const year   = new Date().getFullYear();
  const seq    = Math.floor(1000 + Math.random() * 9000);   // 1000–9999
  const suffix = crypto.randomBytes(1).toString('hex');     // e.g. "a3"
  return `GT-${year}-${seq}${suffix}`;
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
    clientDetails   = body.clientDetails;   // { firstName, lastName, email, phone, address, suburb, state, postcode }
                                            // OR { name, email, phone, ... } for backward compat
  } catch {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  if (!paymentIntentId || !clientDetails?.email) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing paymentIntentId or clientDetails' }) };
  }

  // Normalise name fields — support both { firstName, lastName } and legacy { name }
  const firstName = clientDetails.firstName || (clientDetails.name || '').split(' ')[0] || '';
  const lastName  = clientDetails.lastName  || (clientDetails.name || '').split(' ').slice(1).join(' ') || '';

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
  const orderRef         = generateOrderRef();    // e.g. GT-2026-4821a3  (human-readable)
  const intakeToken      = crypto.randomUUID();   // e.g. 550e8400-e29b-41d4-a716-446655440000
  const now              = new Date().toISOString();

  console.log(`GeneThrive: Finalising order — ${orderRef}`);

  // ── 2. Transfer $137.50 to NutriPath (1st half — for kit dispatch) ────────────
  // 2nd half ($137.50) released by nutripath-submit.js when DNA results are uploaded.
  if (process.env.STRIPE_ACCOUNT_NUTRIPATH) {
    try {
      const t = await stripe.transfers.create({
        amount:      parseInt(process.env.PRICE_NUTRIPATH_1_CENTS || '13750'),
        currency:    'aud',
        destination: process.env.STRIPE_ACCOUNT_NUTRIPATH,
        description: `GeneThrive ${orderRef} — DNA lab payment (1st half — kit dispatch)`,
        metadata:    { orderRef, stage: 'kit-dispatch' },
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
        metadata: { orderRef },
      });

      const subscription = await stripe.subscriptions.create({
        customer:          stripeCustomerId,
        items:             [{ price: process.env.STRIPE_PRICE_MONTHLY }],
        trial_period_days: 30,
        metadata:          { orderRef, product: 'GeneThrive Monthly Vitamins' },
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
    const shopifyRes = await shopifyFetch('/admin/api/2024-01/orders.json', {
      method: 'POST',
      body: JSON.stringify({
        order: {
          email:                    clientDetails.email,
          financial_status:         'paid',
          fulfillment_status:       null,
          send_receipt:             false,
          send_fulfillment_receipt: false,
          tags:                     `stripe-managed,order-ref:${orderRef},awaiting-health-profile`,
          note:                     `Stripe PI: ${paymentIntentId} | Sub: ${subscriptionId || 'pending'}`,
          line_items: [{
            title:             'GeneThrive DNA + First Month Vitamins',
            quantity:          1,
            price:             '549.00',
            requires_shipping: false,
          }],
          billing_address: {
            first_name: firstName,
            last_name:  lastName || '.',
            address1:   clientDetails.address,
            city:       clientDetails.suburb,
            province:   clientDetails.state,
            zip:        clientDetails.postcode,
            country:    'AU',
            phone:      clientDetails.phone,
          },
          shipping_address: {
            first_name: firstName,
            last_name:  lastName || '.',
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
      console.log(`GeneThrive: Shopify order #${shopifyOrderNumber} created for ${orderRef}`);
    }
  } catch (err) {
    console.error('GeneThrive: Shopify order creation failed —', err.message);
  }

  // ── 4b. Create / update Shopify customer ─────────────────────────────────────
  try {
    const accountRes = await shopifyFetch('/admin/api/2024-01/customers.json', {
      method: 'POST',
      body: JSON.stringify({
        customer: {
          first_name:         firstName,
          last_name:          lastName || '.',
          email:              clientDetails.email,
          phone:              clientDetails.phone,
          send_email_invite:  false,
          send_email_welcome: false,
          tags:               `order-ref:${orderRef},genethrive-member`,
          note:               `Order Ref: ${orderRef} | Stripe PI: ${paymentIntentId}`,
          addresses: [{
            address1:   clientDetails.address,
            city:       clientDetails.suburb,
            province:   clientDetails.state,
            zip:        clientDetails.postcode,
            country:    'AU',
            phone:      clientDetails.phone,
            first_name: firstName,
            last_name:  lastName || '.',
            default:    true,
          }],
        },
      }),
    });

    const accountData = await accountRes.json();

    if (!accountRes.ok && accountData.errors?.email) {
      // Email already exists — just add the order-ref tag
      const existingRes  = await shopifyFetch(
        `/admin/api/2024-01/customers/search.json?query=email:${encodeURIComponent(clientDetails.email)}&limit=1`
      );
      const existingData = await existingRes.json();
      const existing     = existingData.customers?.[0];
      if (existing) {
        const tags = existing.tags ? existing.tags.split(', ') : [];
        if (!tags.includes(`order-ref:${orderRef}`)) {
          tags.push(`order-ref:${orderRef}`);
          await shopifyFetch(`/admin/api/2024-01/customers/${existing.id}.json`, {
            method: 'PUT',
            body:   JSON.stringify({ customer: { id: existing.id, tags: tags.join(', ') } }),
          });
        }
        console.log(`GeneThrive: Existing Shopify customer updated — ${orderRef}`);
      }
    } else {
      console.log(`GeneThrive: Shopify customer created — ${orderRef}`);
    }
  } catch (err) {
    console.error('GeneThrive: Customer creation error (non-fatal) —', err.message);
  }

  // ── 5. Insert client_contacts row in Supabase ─────────────────────────────────
  let clientContactId = null;
  try {
    const contact = await insertRow('client_contacts', {
      first_name:    firstName,
      last_name:     lastName,
      email:         clientDetails.email,
      mobile:        clientDetails.phone,
      addr_street:   clientDetails.address,
      addr_suburb:   clientDetails.suburb,
      addr_state:    clientDetails.state,
      addr_postcode: clientDetails.postcode,
    });
    clientContactId = contact?.id || null;
    console.log(`GeneThrive: client_contacts row created — id ${clientContactId}`);
  } catch (err) {
    // Non-fatal: log and continue. Orders row will have null client_contact_id.
    console.error('GeneThrive: client_contacts insert failed —', err.message);
  }

  // ── 6. Insert orders row in Supabase (with intake_token) ──────────────────────
  // PRIVACY: intake_token is a random UUID — safe to put in a URL, unlike order_ref.
  // The health profile wizard exchanges this token for client details to pre-fill the
  // form. Clinical answers are stored in health_profiles (Barbara-only RLS) — never here.
  let supabaseOrderId = null;
  try {
    const order = await insertRow('orders', {
      order_ref:               orderRef,
      client_contact_id:       clientContactId,
      status:                  'paid',
      paid_at:                 now,
      subscription_sku:        'GENETHRIVE-MONTHLY-200',
      intake_token:            intakeToken,
      intake_token_created_at: now,
      // assigned_practitioner_id left null — set later by Barbara
    });
    supabaseOrderId = order?.id || null;
    console.log(`GeneThrive: orders row created — id ${supabaseOrderId}, ref ${orderRef}`);
  } catch (err) {
    // Payment has already succeeded so we still return 200. Paul will see the Shopify
    // order; Barbara will need to manually create the Supabase record if this fails.
    console.error('GeneThrive: CRITICAL — orders insert failed —', err.message);
  }

  // ── 7. Build URLs ──────────────────────────────────────────────────────────────
  // Health profile URL uses the intake_token — NOT the order_ref or any DB id.
  // The token is a random UUID so it's safe to send in a text message or email.
  const healthUrl = `https://genethrive.netlify.app/health-profile?token=${intakeToken}`;
  const storeUrl  = `https://${process.env.SHOPIFY_STORE_DOMAIN}`;

  // ── 8. Send emails ────────────────────────────────────────────────────────────
  // PRIVACY RULE:
  //   - Client email: confirmation + personal health profile link (token-based)
  //   - Ops email: status only — NO health content, NO clinical data, NO intake_token
  //   - NutriPath notified later by submit-health-profile.js (after profile is submitted)
  try {
    const transporter = createTransporter();
    const initialAmt  = ((parseInt(process.env.PRICE_INITIAL_CENTS || '54900')) / 100).toFixed(2);

    await Promise.all([

      // Client — payment confirmed + personal health profile link (token in URL)
      transporter.sendMail({
        from:    process.env.EMAIL_FROM,
        to:      clientDetails.email,
        replyTo: process.env.EMAIL_REPLY_TO,
        subject: `Your GeneThrive order is confirmed — next step inside — ${orderRef}`,
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
                <div style="font-size:18px;font-weight:700">${orderRef}</div>
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
                <li><strong>Complete your health profile</strong> — link above (personal to you)</li>
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

      // Ops — status only, NO health content, NO intake_token
      transporter.sendMail({
        from:    process.env.EMAIL_FROM,
        to:      process.env.EMAIL_OPS,
        replyTo: process.env.EMAIL_REPLY_TO,
        subject: `New order — ${orderRef} — awaiting health profile`,
        html: `
          <div style="font-family:sans-serif;max-width:480px;color:#1c1c1a">
            <div style="background:#1c1c1a;padding:16px 24px;border-radius:8px 8px 0 0">
              <span style="color:#fff;font-size:15px;font-weight:600;letter-spacing:2px">GENETHRIVE</span>
              <span style="color:rgba(255,255,255,0.5);font-size:12px;margin-left:10px">Ops — Status Only</span>
            </div>
            <div style="border:1px solid #d6cfc3;border-top:none;padding:24px;border-radius:0 0 8px 8px">
              <p style="font-size:14px;margin:0 0 16px;color:#4a4a46">
                New order paid. Client sent personal health profile link.
                NutriPath notified after profile is submitted.
              </p>
              <table style="width:100%;font-size:13px;border-collapse:collapse">
                <tr style="border-bottom:1px solid #ede8df">
                  <td style="padding:8px 0;color:#7a7a74;width:160px">Order Ref</td>
                  <td style="padding:8px 0;font-weight:600">${orderRef}</td>
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

    console.log(`GeneThrive: Emails sent — ${orderRef}`);
  } catch (err) {
    console.error('GeneThrive: Email sending failed —', err.message);
  }

  // ── 9. SMS client with personal health profile link (non-fatal) ───────────────
  // Uses intake_token URL — the token is opaque so there's no risk exposing it in SMS.
  if (clientDetails.phone) {
    const e164 = formatAustralianPhone(clientDetails.phone);
    await sendSmsSafe(
      e164,
      `GeneThrive: Payment confirmed! Reference: ${orderRef}. ` +
      `Complete your health profile: ${healthUrl}`,
      `order ${orderRef}`
    );
    console.log(`GeneThrive: SMS sent to client — ${orderRef}`);
  }

  // ── 10. Return to browser ─────────────────────────────────────────────────────
  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({
      success:      true,
      clientId:     orderRef,    // kept as 'clientId' key for backward-compat with payment page JS
      orderRef,
      shopifyOrder: shopifyOrderNumber,
      subscription: subscriptionId,
    }),
  };
};