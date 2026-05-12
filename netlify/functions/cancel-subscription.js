/**
 * GeneThrive — Cancel Subscription
 * ─────────────────────────────────────────────────────────────────────────────
 * Netlify Function: netlify/functions/cancel-subscription.js
 *
 * CALLED BY: page.cancel.liquid when client confirms cancellation
 *
 * WHAT IT DOES:
 *   1. Verifies the client ID matches a real Shopify order
 *   2. Finds the Stripe customer by email from the order
 *   3. Cancels the subscription at end of current billing period
 *      (cancel_at_period_end: true — client keeps access until period ends)
 *   4. Tags the Shopify order as cancellation-requested
 *   5. Emails the client a cancellation confirmation
 *   6. Emails ops so they're aware
 *
 * ENVIRONMENT VARIABLES:
 *   STRIPE_SECRET_KEY      = sk_test_xxxx or sk_live_xxxx
 *   SHOPIFY_STORE_DOMAIN   = yourstore.myshopify.com
 *   SHOPIFY_ADMIN_TOKEN    = shpat_xxxx
 *   SMTP_HOST / PORT / USER / PASS
 *   EMAIL_FROM
 *   EMAIL_OPS
 *   EMAIL_REPLY_TO
 * ─────────────────────────────────────────────────────────────────────────────
 */

const Stripe     = require('stripe');
const nodemailer = require('nodemailer');
const { shopifyFetch } = require('./shopify-token');

function createTransporter() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587', 10),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

exports.handler = async function (event) {

  const corsHeaders = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST')   return { statusCode: 405, headers: corsHeaders, body: 'Method not allowed' };

  // 1. Parse request
  let clientId, email;
  try {
    const body = JSON.parse(event.body);
    clientId   = body.clientId?.trim();
    email      = body.email?.trim().toLowerCase();
  } catch {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  if (!clientId || !email) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Missing clientId or email' }),
    };
  }

  // 2. Look up the Shopify order to verify client ID + email match
  let order;
  try {
    const res  = await shopifyFetch(
      `/admin/api/2024-01/orders.json?tag=client-id:${encodeURIComponent(clientId)}&status=any&limit=1`
    );
    const data = await res.json();
    order      = data.orders?.[0];
  } catch (err) {
    console.error('GeneThrive cancel: Shopify lookup failed —', err.message);
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Could not verify order' }) };
  }

  if (!order) {
    return {
      statusCode: 404,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'No order found for this Client ID. Please check and try again.' }),
    };
  }

  // Verify the email matches the order to prevent unauthorised cancellations
  if (order.email.toLowerCase() !== email) {
    return {
      statusCode: 403,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Email address does not match our records for this Client ID.' }),
    };
  }

  // Check if already cancelled
  if (order.tags?.includes('subscription-cancelled') || order.tags?.includes('cancellation-requested')) {
    return {
      statusCode: 409,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'This subscription has already been cancelled or a cancellation is already pending.' }),
    };
  }

  // 3. Find the Stripe customer by email
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  let customer;
  try {
    const customers = await stripe.customers.list({ email, limit: 1 });
    customer = customers.data?.[0];
  } catch (err) {
    console.error('GeneThrive cancel: Stripe customer lookup failed —', err.message);
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Could not find subscription' }) };
  }

  if (!customer) {
    return {
      statusCode: 404,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'No subscription found for this email address.' }),
    };
  }

  // 4. Find the active subscription
  let subscription;
  try {
    const subscriptions = await stripe.subscriptions.list({
      customer: customer.id,
      status:   'active',
      limit:    1,
    });

    // Also check trialing subscriptions
    if (!subscriptions.data.length) {
      const trialing = await stripe.subscriptions.list({
        customer: customer.id,
        status:   'trialing',
        limit:    1,
      });
      subscription = trialing.data?.[0];
    } else {
      subscription = subscriptions.data[0];
    }
  } catch (err) {
    console.error('GeneThrive cancel: Subscription lookup failed —', err.message);
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Could not find subscription' }) };
  }

  if (!subscription) {
    return {
      statusCode: 404,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'No active subscription found for this account.' }),
    };
  }

  // 5. Cancel at end of current billing period
  let updatedSubscription;
  try {
    updatedSubscription = await stripe.subscriptions.update(subscription.id, {
      cancel_at_period_end: true,
    });
    console.log(`GeneThrive: Subscription ${subscription.id} set to cancel at period end for ${email}`);
  } catch (err) {
    console.error('GeneThrive cancel: Stripe cancellation failed —', err.message);
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Could not cancel subscription. Please contact support.' }) };
  }

  // Format the end date nicely
  // During trial, use trial_end as the effective end date
  // After trial, use current_period_end
  const endTimestamp = updatedSubscription.trial_end || updatedSubscription.current_period_end;

  console.log('GeneThrive cancel: trial_end =', updatedSubscription.trial_end);
  console.log('GeneThrive cancel: current_period_end =', updatedSubscription.current_period_end);
  console.log('GeneThrive cancel: using endTimestamp =', endTimestamp);

  let periodEnd = 'your next billing date';
  if (endTimestamp) {
    try {
      periodEnd = new Date(endTimestamp * 1000).toLocaleDateString('en-AU', {
        day: '2-digit', month: 'long', year: 'numeric',
      });
    } catch (err) {
      console.error('GeneThrive cancel: Date formatting failed —', err.message);
    }
  }

  // 6. Tag the Shopify order
  try {
    const existingTags = order.tags ? order.tags.split(', ') : [];
    existingTags.push('cancellation-requested');
    await shopifyFetch(
      `/admin/api/2024-01/orders/${order.id}.json`,
      {
        method: 'PUT',
        body:   JSON.stringify({ order: { id: order.id, tags: existingTags.join(', ') } }),
      }
    );
    console.log(`GeneThrive: Order #${order.order_number} tagged cancellation-requested`);
  } catch (err) {
    console.warn('GeneThrive cancel: Order tagging failed —', err.message);
  }

  // 7. Send emails
  try {
    const transporter = createTransporter();
    const firstName   = order.shipping_address?.first_name || email;

    await Promise.all([

      // Client confirmation
      transporter.sendMail({
        from:    process.env.EMAIL_FROM,
        to:      email,
        replyTo: process.env.EMAIL_REPLY_TO,
        subject: 'Your GeneThrive subscription cancellation is confirmed',
        html: `
          <div style="font-family:sans-serif;max-width:520px;color:#1c1c1a">
            <div style="background:#4a6741;padding:20px 24px;border-radius:8px 8px 0 0">
              <span style="color:#fff;font-size:16px;font-weight:600;letter-spacing:2px">GENETHRIVE</span>
            </div>
            <div style="border:1px solid #d6cfc3;border-top:none;padding:28px;border-radius:0 0 8px 8px">
              <h2 style="margin:0 0 14px;font-size:18px;font-weight:500">Cancellation confirmed, ${firstName}</h2>
              <p style="margin:0 0 16px;font-size:14px;color:#4a4a46;line-height:1.6">
                Your GeneThrive personalised vitamin subscription has been scheduled for cancellation.
              </p>
              <div style="background:#f7f4ee;border-radius:8px;padding:18px;margin-bottom:20px">
                <table style="width:100%;font-size:13px;border-collapse:collapse">
                  <tr style="border-bottom:1px solid #ede8df">
                    <td style="padding:8px 0;color:#7a7a74">Client ID</td>
                    <td style="padding:8px 0;font-weight:600">${clientId}</td>
                  </tr>
                  <tr style="border-bottom:1px solid #ede8df">
                    <td style="padding:8px 0;color:#7a7a74">Status</td>
                    <td style="padding:8px 0;color:#4a6741;font-weight:500">Active until ${periodEnd}</td>
                  </tr>
                  <tr>
                    <td style="padding:8px 0;color:#7a7a74">Final charge</td>
                    <td style="padding:8px 0">No further charges after ${periodEnd}</td>
                  </tr>
                </table>
              </div>
              <p style="font-size:14px;color:#4a4a46;line-height:1.6;margin:0 0 16px">
                You will continue to receive your vitamins until <strong>${periodEnd}</strong>.
                After this date, no further charges will be made and deliveries will stop.
              </p>
              <p style="font-size:13px;color:#7a7a74;margin:0;line-height:1.6">
                Changed your mind? Contact us at
                <a href="mailto:${process.env.EMAIL_REPLY_TO}" style="color:#4a6741">${process.env.EMAIL_REPLY_TO}</a>
                before ${periodEnd} and we can reactivate your subscription.
              </p>
            </div>
          </div>
        `,
      }),

      // Ops notification
      transporter.sendMail({
        from:    process.env.EMAIL_FROM,
        to:      process.env.EMAIL_OPS,
        replyTo: process.env.EMAIL_REPLY_TO,
        subject: `Subscription cancellation — ${clientId} — active until ${periodEnd}`,
        html: `
          <div style="font-family:sans-serif;max-width:480px;color:#1c1c1a">
            <div style="background:#1c1c1a;padding:16px 24px;border-radius:8px 8px 0 0">
              <span style="color:#fff;font-size:15px;font-weight:600;letter-spacing:2px">GENETHRIVE</span>
              <span style="color:rgba(255,255,255,0.5);font-size:12px;margin-left:10px">Cancellation Request</span>
            </div>
            <div style="border:1px solid #d6cfc3;border-top:none;padding:24px;border-radius:0 0 8px 8px">
              <p style="font-size:14px;margin:0 0 16px">A client has requested subscription cancellation.</p>
              <table style="width:100%;font-size:13px;border-collapse:collapse">
                <tr style="border-bottom:1px solid #ede8df">
                  <td style="padding:8px 0;color:#7a7a74;width:140px">Client ID</td>
                  <td style="padding:8px 0;font-weight:600">${clientId}</td>
                </tr>
                <tr style="border-bottom:1px solid #ede8df">
                  <td style="padding:8px 0;color:#7a7a74">Email</td>
                  <td style="padding:8px 0">${email}</td>
                </tr>
                <tr style="border-bottom:1px solid #ede8df">
                  <td style="padding:8px 0;color:#7a7a74">Shopify order</td>
                  <td style="padding:8px 0">#${order.order_number}</td>
                </tr>
                <tr style="border-bottom:1px solid #ede8df">
                  <td style="padding:8px 0;color:#7a7a74">Active until</td>
                  <td style="padding:8px 0;color:#4a6741;font-weight:500">${periodEnd}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;color:#7a7a74">Stripe sub</td>
                  <td style="padding:8px 0;font-family:monospace;font-size:12px">${subscription.id}</td>
                </tr>
              </table>
              <p style="margin:16px 0 0;font-size:12px;color:#7a7a74">
                No action needed — Stripe will automatically stop billing on ${periodEnd}.
                Stop vitamin dispatch after this date.
              </p>
            </div>
          </div>
        `,
      }),

    ]);
    console.log(`GeneThrive: Cancellation emails sent for ${clientId}`);
  } catch (err) {
    console.error('GeneThrive cancel: Email sending failed —', err.message);
  }

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({
      success:    true,
      clientId,
      periodEnd,
      message:    `Subscription cancelled. Active until ${periodEnd}.`,
    }),
  };
};