/**
 * GeneThrive — Stripe Subscription Webhook Handler
 * ─────────────────────────────────────────────────────────────────────────────
 * Netlify Function: netlify/functions/handle-subscription.js
 *
 * TRIGGERED BY: Stripe webhooks for subscription events
 *
 * HANDLES THESE STRIPE EVENTS:
 *   invoice.paid                    → monthly $200 charge succeeded
 *   invoice.payment_failed          → monthly charge failed — notify ops + client
 *   customer.subscription.deleted   → subscription cancelled
 *   customer.subscription.updated   → subscription changed (pause, resume etc.)
 *
 * SETUP:
 *   Stripe dashboard → Developers → Webhooks → Add endpoint
 *   URL:    https://genethrive.netlify.app/.netlify/functions/handle-subscription
 *   Events: invoice.paid
 *           invoice.payment_failed
 *           customer.subscription.deleted
 *           customer.subscription.updated
 *   Copy the signing secret → add as STRIPE_WEBHOOK_SECRET in Netlify
 *
 * ENVIRONMENT VARIABLES:
 *   STRIPE_SECRET_KEY      = sk_test_xxxx or sk_live_xxxx
 *   STRIPE_WEBHOOK_SECRET  = whsec_xxxx (from Stripe webhook setup)
 *   SHOPIFY_STORE_DOMAIN   = your-store.myshopify.com
 *   SHOPIFY_ADMIN_TOKEN    = shpat_xxxx
 *   SMTP_HOST / PORT / USER / PASS
 *   EMAIL_FROM
 *   EMAIL_OPS
 *   EMAIL_REPLY_TO
 * ─────────────────────────────────────────────────────────────────────────────
 */

const Stripe     = require('stripe');
const nodemailer = require('nodemailer');

// ── Email transporter ─────────────────────────────────────────────────────────

function createTransporter() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587', 10),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

// ── Shopify helpers ───────────────────────────────────────────────────────────

async function getShopifyOrderByClientId(clientId) {
  if (!clientId) return null;
  try {
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
  } catch {
    return null;
  }
}

async function tagShopifyOrder(orderId, existingTags, newTag) {
  try {
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
  } catch (err) {
    console.warn('GeneThrive: Shopify tagging failed —', err.message);
  }
}

// ── Event handlers ────────────────────────────────────────────────────────────

/**
 * invoice.paid — monthly $200 charge succeeded
 * Sends client a receipt and tags the Shopify order
 */
async function handleInvoicePaid(stripe, invoice, transporter) {

  // Skip the first invoice — that's the $575 initial charge, not the monthly
  // The subscription was created with a 30-day trial so first monthly
  // invoice fires after 30 days
  if (invoice.billing_reason === 'subscription_create') {
    console.log('GeneThrive: Skipping subscription_create invoice (initial charge)');
    return;
  }

  const customerId   = invoice.customer;
  const amountPaid   = (invoice.amount_paid / 100).toFixed(2);
  const invoiceMonth = new Date(invoice.period_end * 1000).toLocaleDateString('en-AU', {
    month: 'long', year: 'numeric',
  });

  // Get customer details from Stripe
  const customer = await stripe.customers.retrieve(customerId);
  const clientId = customer.metadata?.clientId || null;

  console.log(`GeneThrive: Monthly invoice paid — $${amountPaid} for customer ${customerId} (${clientId || 'no clientId'})`);

  // Tag Shopify order
  if (clientId) {
    const order = await getShopifyOrderByClientId(clientId);
    if (order) {
      await tagShopifyOrder(order.id, order.tags, `monthly-paid-${invoiceMonth.toLowerCase().replace(' ', '-')}`);
    }
  }

  // Send client receipt
  if (customer.email) {
    try {
      await transporter.sendMail({
        from:    process.env.EMAIL_FROM,
        to:      customer.email,
        replyTo: process.env.EMAIL_REPLY_TO,
        subject: `Your GeneThrive vitamins — ${invoiceMonth} payment confirmed`,
        html: `
          <div style="font-family:sans-serif;max-width:520px;color:#1c1c1a">
            <div style="background:#4a6741;padding:20px 24px;border-radius:8px 8px 0 0">
              <span style="color:#fff;font-size:16px;font-weight:600;letter-spacing:2px">GENETHRIVE</span>
            </div>
            <div style="border:1px solid #d6cfc3;border-top:none;padding:28px;border-radius:0 0 8px 8px">
              <h2 style="margin:0 0 14px;font-size:18px;font-weight:500">Payment confirmed</h2>
              <p style="margin:0 0 20px;font-size:14px;color:#4a4a46;line-height:1.6">
                Your monthly vitamin subscription payment has been processed successfully.
              </p>
              <div style="background:#f7f4ee;border-radius:8px;padding:18px;margin-bottom:20px">
                <table style="width:100%;font-size:13px;border-collapse:collapse">
                  <tr style="border-bottom:1px solid #ede8df">
                    <td style="padding:8px 0;color:#7a7a74">Description</td>
                    <td style="padding:8px 0;text-align:right">GeneThrive Monthly Vitamins</td>
                  </tr>
                  <tr style="border-bottom:1px solid #ede8df">
                    <td style="padding:8px 0;color:#7a7a74">Period</td>
                    <td style="padding:8px 0;text-align:right">${invoiceMonth}</td>
                  </tr>
                  ${clientId ? `<tr style="border-bottom:1px solid #ede8df">
                    <td style="padding:8px 0;color:#7a7a74">Reference</td>
                    <td style="padding:8px 0;text-align:right;font-weight:500">${clientId}</td>
                  </tr>` : ''}
                  <tr>
                    <td style="padding:10px 0 0;color:#7a7a74;font-weight:500">Amount charged</td>
                    <td style="padding:10px 0 0;text-align:right;font-size:18px;font-weight:700;color:#1c1c1a">$${amountPaid}</td>
                  </tr>
                </table>
              </div>
              <p style="font-size:13px;color:#7a7a74;line-height:1.6;margin:0">
                Your personalised vitamins will be dispatched shortly. Questions?
                Contact us at <a href="mailto:${process.env.EMAIL_REPLY_TO}" style="color:#4a6741">${process.env.EMAIL_REPLY_TO}</a>
              </p>
            </div>
          </div>
        `,
      });
      console.log(`GeneThrive: Monthly receipt sent to ${customer.email}`);
    } catch (err) {
      console.error('GeneThrive: Receipt email failed —', err.message);
    }
  }

  // Notify ops
  try {
    await transporter.sendMail({
      from:    process.env.EMAIL_FROM,
      to:      process.env.EMAIL_OPS,
      replyTo: process.env.EMAIL_REPLY_TO,
      subject: `Monthly payment received — $${amountPaid} — ${customer.email}`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;color:#1c1c1a">
          <div style="background:#1c1c1a;padding:16px 24px;border-radius:8px 8px 0 0">
            <span style="color:#fff;font-size:15px;font-weight:600;letter-spacing:2px">GENETHRIVE</span>
            <span style="color:rgba(255,255,255,0.5);font-size:12px;margin-left:10px">Monthly Payment</span>
          </div>
          <div style="border:1px solid #d6cfc3;border-top:none;padding:24px;border-radius:0 0 8px 8px">
            <table style="width:100%;font-size:13px;border-collapse:collapse">
              <tr style="border-bottom:1px solid #ede8df">
                <td style="padding:8px 0;color:#7a7a74;width:130px">Client</td>
                <td style="padding:8px 0">${customer.email}</td>
              </tr>
              ${clientId ? `<tr style="border-bottom:1px solid #ede8df">
                <td style="padding:8px 0;color:#7a7a74">Client ID</td>
                <td style="padding:8px 0;font-weight:600">${clientId}</td>
              </tr>` : ''}
              <tr style="border-bottom:1px solid #ede8df">
                <td style="padding:8px 0;color:#7a7a74">Period</td>
                <td style="padding:8px 0">${invoiceMonth}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;color:#7a7a74">Amount</td>
                <td style="padding:8px 0;font-weight:600;color:#166534;font-size:16px">$${amountPaid}</td>
              </tr>
            </table>
            <p style="margin:16px 0 0;font-size:12px;color:#7a7a74">
              Action: dispatch this month's vitamins to the client.
            </p>
          </div>
        </div>
      `,
    });
  } catch (err) {
    console.error('GeneThrive: Ops monthly notification failed —', err.message);
  }
}

/**
 * invoice.payment_failed — monthly charge failed
 * Notifies ops and sends client a payment failure email with retry instructions
 */
async function handlePaymentFailed(stripe, invoice, transporter) {
  const customerId   = invoice.customer;
  const customer     = await stripe.customers.retrieve(customerId);
  const clientId     = customer.metadata?.clientId || null;
  const attemptCount = invoice.attempt_count;
  const nextAttempt  = invoice.next_payment_attempt
    ? new Date(invoice.next_payment_attempt * 1000).toLocaleDateString('en-AU', { day: '2-digit', month: 'long', year: 'numeric' })
    : null;

  console.log(`GeneThrive: Payment failed — attempt ${attemptCount} for ${customer.email}`);

  // Email client
  if (customer.email) {
    try {
      await transporter.sendMail({
        from:    process.env.EMAIL_FROM,
        to:      customer.email,
        replyTo: process.env.EMAIL_REPLY_TO,
        subject: 'Action needed — GeneThrive payment failed',
        html: `
          <div style="font-family:sans-serif;max-width:520px;color:#1c1c1a">
            <div style="background:#B91C1C;padding:20px 24px;border-radius:8px 8px 0 0">
              <span style="color:#fff;font-size:16px;font-weight:600;letter-spacing:2px">GENETHRIVE</span>
            </div>
            <div style="border:1px solid #FECACA;border-top:none;padding:28px;border-radius:0 0 8px 8px">
              <h2 style="margin:0 0 14px;font-size:18px;font-weight:500;color:#B91C1C">Payment unsuccessful</h2>
              <p style="margin:0 0 16px;font-size:14px;color:#4a4a46;line-height:1.6">
                We were unable to process your monthly vitamin subscription payment of <strong>$200.00</strong>.
                This is usually due to an expired card or insufficient funds.
              </p>
              ${nextAttempt ? `
              <div style="background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;padding:14px;margin-bottom:20px">
                <p style="margin:0;font-size:13px;color:#B91C1C">
                  We'll automatically retry on <strong>${nextAttempt}</strong>.
                  Please update your payment details before then to avoid interruption to your vitamins.
                </p>
              </div>` : ''}
              <p style="font-size:13px;color:#4a4a46;margin:0 0 20px;line-height:1.6">
                To update your card details or resolve this issue, please contact us directly at
                <a href="mailto:${process.env.EMAIL_REPLY_TO}" style="color:#4a6741">${process.env.EMAIL_REPLY_TO}</a>
                and we'll get it sorted quickly.
              </p>
              <p style="font-size:12px;color:#7a7a74;margin:0">
                Attempt ${attemptCount} of 4. After 4 failed attempts your subscription will be cancelled.
              </p>
            </div>
          </div>
        `,
      });
    } catch (err) {
      console.error('GeneThrive: Payment failed email error —', err.message);
    }
  }

  // Alert ops
  try {
    await transporter.sendMail({
      from:    process.env.EMAIL_FROM,
      to:      process.env.EMAIL_OPS,
      replyTo: process.env.EMAIL_REPLY_TO,
      subject: `⚠ Payment failed — ${customer.email} — attempt ${attemptCount}`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;color:#1c1c1a">
          <div style="background:#B91C1C;padding:16px 24px;border-radius:8px 8px 0 0">
            <span style="color:#fff;font-size:15px;font-weight:600;letter-spacing:2px">GENETHRIVE</span>
            <span style="color:rgba(255,255,255,0.7);font-size:12px;margin-left:10px">Payment Failed</span>
          </div>
          <div style="border:1px solid #FECACA;border-top:none;padding:24px;border-radius:0 0 8px 8px">
            <table style="width:100%;font-size:13px;border-collapse:collapse">
              <tr style="border-bottom:1px solid #ede8df">
                <td style="padding:8px 0;color:#7a7a74;width:130px">Client</td>
                <td style="padding:8px 0">${customer.email}</td>
              </tr>
              ${clientId ? `<tr style="border-bottom:1px solid #ede8df">
                <td style="padding:8px 0;color:#7a7a74">Client ID</td>
                <td style="padding:8px 0;font-weight:600">${clientId}</td>
              </tr>` : ''}
              <tr style="border-bottom:1px solid #ede8df">
                <td style="padding:8px 0;color:#7a7a74">Attempt</td>
                <td style="padding:8px 0">${attemptCount} of 4</td>
              </tr>
              <tr style="border-bottom:1px solid #ede8df">
                <td style="padding:8px 0;color:#7a7a74">Next retry</td>
                <td style="padding:8px 0">${nextAttempt || 'No further retries'}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;color:#7a7a74">Amount</td>
                <td style="padding:8px 0;font-weight:600;color:#B91C1C">$200.00 — FAILED</td>
              </tr>
            </table>
            <p style="margin:16px 0 0;font-size:12px;color:#7a7a74">
              Client has been notified. Consider reaching out directly if this is attempt 3+.
            </p>
          </div>
        </div>
      `,
    });
  } catch (err) {
    console.error('GeneThrive: Ops payment failed alert error —', err.message);
  }
}

/**
 * customer.subscription.deleted — subscription cancelled
 * Notifies ops and sends client a cancellation confirmation
 */
async function handleSubscriptionCancelled(stripe, subscription, transporter) {
  const customerId = subscription.customer;
  const customer   = await stripe.customers.retrieve(customerId);
  const clientId   = customer.metadata?.clientId || null;

  console.log(`GeneThrive: Subscription cancelled for ${customer.email}`);

  // Tag Shopify order
  if (clientId) {
    const order = await getShopifyOrderByClientId(clientId);
    if (order) await tagShopifyOrder(order.id, order.tags, 'subscription-cancelled');
  }

  // Email client
  if (customer.email) {
    try {
      await transporter.sendMail({
        from:    process.env.EMAIL_FROM,
        to:      customer.email,
        replyTo: process.env.EMAIL_REPLY_TO,
        subject: 'Your GeneThrive subscription has been cancelled',
        html: `
          <div style="font-family:sans-serif;max-width:520px;color:#1c1c1a">
            <div style="background:#4a6741;padding:20px 24px;border-radius:8px 8px 0 0">
              <span style="color:#fff;font-size:16px;font-weight:600;letter-spacing:2px">GENETHRIVE</span>
            </div>
            <div style="border:1px solid #d6cfc3;border-top:none;padding:28px;border-radius:0 0 8px 8px">
              <h2 style="margin:0 0 14px;font-size:18px;font-weight:500">Subscription cancelled</h2>
              <p style="margin:0 0 16px;font-size:14px;color:#4a4a46;line-height:1.6">
                Your GeneThrive personalised vitamin subscription has been cancelled.
                No further charges will be made.
              </p>
              <p style="font-size:14px;color:#4a4a46;line-height:1.6;margin:0 0 20px">
                We're sorry to see you go. If you'd like to restart your subscription or
                have any questions, please reach out at
                <a href="mailto:${process.env.EMAIL_REPLY_TO}" style="color:#4a6741">${process.env.EMAIL_REPLY_TO}</a>
              </p>
            </div>
          </div>
        `,
      });
    } catch (err) {
      console.error('GeneThrive: Cancellation email error —', err.message);
    }
  }

  // Notify ops
  try {
    await transporter.sendMail({
      from:    process.env.EMAIL_FROM,
      to:      process.env.EMAIL_OPS,
      replyTo: process.env.EMAIL_REPLY_TO,
      subject: `Subscription cancelled — ${customer.email}${clientId ? ` — ${clientId}` : ''}`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;color:#1c1c1a">
          <div style="background:#1c1c1a;padding:16px 24px;border-radius:8px 8px 0 0">
            <span style="color:#fff;font-size:15px;font-weight:600;letter-spacing:2px">GENETHRIVE</span>
          </div>
          <div style="border:1px solid #d6cfc3;border-top:none;padding:24px;border-radius:0 0 8px 8px">
            <p style="font-size:14px;margin:0 0 16px">A client subscription has been cancelled.</p>
            <table style="width:100%;font-size:13px;border-collapse:collapse">
              <tr style="border-bottom:1px solid #ede8df">
                <td style="padding:8px 0;color:#7a7a74;width:130px">Client</td>
                <td style="padding:8px 0">${customer.email}</td>
              </tr>
              ${clientId ? `<tr style="border-bottom:1px solid #ede8df">
                <td style="padding:8px 0;color:#7a7a74">Client ID</td>
                <td style="padding:8px 0;font-weight:600">${clientId}</td>
              </tr>` : ''}
              <tr>
                <td style="padding:8px 0;color:#7a7a74">Status</td>
                <td style="padding:8px 0;color:#B91C1C;font-weight:500">Cancelled — no further charges</td>
              </tr>
            </table>
          </div>
        </div>
      `,
    });
  } catch (err) {
    console.error('GeneThrive: Ops cancellation alert error —', err.message);
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

exports.handler = async function (event) {

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

  // 1. Verify the webhook came from Stripe using the signing secret
  const sig         = event.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, webhookSecret);
  } catch (err) {
    console.error('GeneThrive: Stripe webhook signature verification failed —', err.message);
    return { statusCode: 400, body: `Webhook error: ${err.message}` };
  }

  console.log(`GeneThrive: Stripe event received — ${stripeEvent.type}`);

  const transporter = createTransporter();

  // 2. Route to the correct handler
  try {
    switch (stripeEvent.type) {

      case 'invoice.paid':
        await handleInvoicePaid(stripe, stripeEvent.data.object, transporter);
        break;

      case 'invoice.payment_failed':
        await handlePaymentFailed(stripe, stripeEvent.data.object, transporter);
        break;

      case 'customer.subscription.deleted':
        await handleSubscriptionCancelled(stripe, stripeEvent.data.object, transporter);
        break;

      case 'customer.subscription.updated':
        // Log for now — can be extended for pause/resume handling
        console.log(`GeneThrive: Subscription updated for customer ${stripeEvent.data.object.customer}`);
        break;

      default:
        console.log(`GeneThrive: Unhandled event type — ${stripeEvent.type}`);
    }
  } catch (err) {
    console.error(`GeneThrive: Handler error for ${stripeEvent.type} —`, err.message);
    // Still return 200 so Stripe doesn't keep retrying
  }

  // Always return 200 to Stripe — retries cause duplicate emails
  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
