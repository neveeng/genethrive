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
 *   3. Transfers $275 to Nutripath via Stripe Connect
 *   4. Transfers $95 to Ops via Stripe Connect
 *   5. Creates $200/month Stripe Subscription on the saved card
 *   6. Creates a Shopify order via Admin API for records
 *   7. Generates Ops PDF + Lab PDF
 *   8. Emails PDFs to ops + lab + sends client confirmation
 *   9. Returns clientId to the browser for the confirmation page
 *
 * ENVIRONMENT VARIABLES REQUIRED:
 *   STRIPE_SECRET_KEY          = sk_test_xxxx (test) or sk_live_xxxx (live)
 *   STRIPE_ACCOUNT_NUTRIPATH   = acct_xxxx  (Stripe Connect account)
 *   STRIPE_ACCOUNT_OPS         = acct_xxxx  (Stripe Connect account)
 *   STRIPE_PRICE_MONTHLY       = price_xxxx (recurring $200/mo product)
 *   SHOPIFY_STORE_DOMAIN       = yourstore.myshopify.com (no https://)
 *   SHOPIFY_ADMIN_TOKEN        = shpat_xxxx
 *   SMTP_HOST                  = smtp.gmail.com
 *   SMTP_PORT                  = 587
 *   SMTP_USER                  = your@email.com
 *   SMTP_PASS                  = your-app-password
 *   EMAIL_FROM                 = GeneThrive <orders@genethrive.com>
 *   EMAIL_OPS                  = ops@genethrive.com
 *   EMAIL_LAB                  = lab@nutripath.com.au
 *   EMAIL_REPLY_TO             = support@genethrive.com
 * ─────────────────────────────────────────────────────────────────────────────
 */

import Stripe from 'stripe';
import { createHash } from 'crypto';
import { createTransport } from 'nodemailer';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { shopifyFetch } from './shopify-token';

// ── Env var validation ────────────────────────────────────────────────────────

function validateEnv() {
  const required = [
    'STRIPE_SECRET_KEY',
    'SHOPIFY_SHOP',
    'SHOPIFY_CLIENT_ID',
    'SHOPIFY_CLIENT_SECRET',
    'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS',
    'EMAIL_FROM', 'EMAIL_OPS', 'EMAIL_LAB', 'EMAIL_REPLY_TO',
  ];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    console.error('GeneThrive: Missing env vars —', missing.join(', '));
    return false;
  }

  // Warn about Stripe Connect vars (non-fatal — transfers skipped if missing)
  if (!process.env.STRIPE_ACCOUNT_NUTRIPATH) console.warn('GeneThrive: STRIPE_ACCOUNT_NUTRIPATH not set — Nutripath transfer will be skipped');
  if (!process.env.STRIPE_ACCOUNT_OPS)       console.warn('GeneThrive: STRIPE_ACCOUNT_OPS not set — Ops transfer will be skipped');
  if (!process.env.STRIPE_PRICE_MONTHLY)     console.warn('GeneThrive: STRIPE_PRICE_MONTHLY not set — subscription will be skipped');

  return true;
}

// ── Client ID ────────────────────────────────────────────────────────────────

function generateClientId(paymentIntentId) {
  const hash = createHash('sha256')
    .update(paymentIntentId)
    .digest('hex')
    .slice(0, 6);
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `GT-${rand}-${hash}`;
}

// ── PDF helpers ───────────────────────────────────────────────────────────────

const COLORS = {
  sage:   rgb(0.29, 0.40, 0.25),
  ink:    rgb(0.11, 0.11, 0.10),
  soft:   rgb(0.48, 0.48, 0.45),
  border: rgb(0.84, 0.81, 0.76),
  cream:  rgb(0.97, 0.96, 0.93),
  white:  rgb(1, 1, 1),
  amber:  rgb(0.69, 0.54, 0.31),
};

function drawRule(page, y) {
  page.drawLine({ start: { x: 40, y }, end: { x: 555, y }, thickness: 0.5, color: COLORS.border });
}

function drawRow(page, fonts, y, label, value) {
  // Strip any characters outside WinAnsi range to avoid PDF encoding errors
  const safeValue = String(value || '—').replace(/[^\x00-\xFF]/g, '?');
  const safeLabel = String(label).replace(/[^\x00-\xFF]/g, '?');
  page.drawText(safeLabel, { x: 40, y, size: 10, font: fonts.regular, color: COLORS.soft });
  page.drawText(safeValue, { x: 220, y, size: 10, font: fonts.regular, color: COLORS.ink, maxWidth: 330 });
  return y - 18;
}

function drawSection(page, fonts, y, text) {
  page.drawRectangle({ x: 40, y: y - 4, width: 515, height: 20, color: COLORS.cream });
  page.drawText(text.toUpperCase(), { x: 46, y, size: 8, font: fonts.bold, color: COLORS.sage, characterSpacing: 1 });
  return y - 26;
}

function drawHeader(page, fonts, title, subtitle) {
  page.drawRectangle({ x: 0, y: 782, width: 595, height: 60, color: COLORS.sage });
  page.drawText('GENETHRIVE', { x: 40, y: 808, size: 16, font: fonts.bold, color: COLORS.white, characterSpacing: 3 });
  page.drawText('Personalised Nutrition', { x: 40, y: 793, size: 9, font: fonts.regular, color: rgb(0.75, 0.87, 0.72) });
  page.drawText(title, { x: 40, y: 758, size: 14, font: fonts.bold, color: COLORS.ink });
  if (subtitle) page.drawText(subtitle, { x: 40, y: 742, size: 9, font: fonts.regular, color: COLORS.soft });
  drawRule(page, 734);
  return 718;
}

function drawFooter(page, fonts, text) {
  drawRule(page, 44);
  page.drawText(text, { x: 40, y: 30, size: 8, font: fonts.regular, color: COLORS.soft });
  page.drawText('CONFIDENTIAL', { x: 490, y: 30, size: 8, font: fonts.bold, color: COLORS.soft, characterSpacing: 1 });
}

async function generateOpsPdf(clientId, clientDetails, healthData, orderDate) {
  const pdfDoc = await PDFDocument.create();
  const page   = pdfDoc.addPage([595, 842]);
  const fonts  = {
    regular: await pdfDoc.embedFont(StandardFonts.Helvetica),
    bold:    await pdfDoc.embedFont(StandardFonts.HelveticaBold),
  };

  let y = drawHeader(page, fonts, 'Order Summary — Ops Copy', `${orderDate}  |  INTERNAL USE ONLY`);

  y = drawSection(page, fonts, y, 'Client Details');
  y -= 4;
  y = drawRow(page, fonts, y, 'Client ID',   clientId);
  y = drawRow(page, fonts, y, 'Name',        clientDetails.name);
  y = drawRow(page, fonts, y, 'Email',       clientDetails.email);
  y = drawRow(page, fonts, y, 'Phone',       clientDetails.phone);
  y = drawRow(page, fonts, y, 'Address',
    `${clientDetails.address}, ${clientDetails.suburb} ${clientDetails.state} ${clientDetails.postcode}`
  );

  y -= 10; drawRule(page, y); y -= 20;

  y = drawSection(page, fonts, y, 'Payment Breakdown — $575.00');
  y -= 4;
  y = drawRow(page, fonts, y, 'Nutripath (DNA lab)',  '$275.00 — transferred immediately');
  y = drawRow(page, fonts, y, 'Ops / GeneThrive',     '$95.00 — transferred immediately');
  y = drawRow(page, fonts, y, 'Pharmacist',           '$140.00 — release on pickup confirmation');
  y = drawRow(page, fonts, y, 'Naturopath',           '$65.00 — release on CIL completion');
  y -= 6;
  page.drawText('Monthly recurring: $200.00 auto-debit via Stripe Subscription', {
    x: 40, y, size: 9, font: fonts.bold, color: COLORS.amber,
  });
  y -= 20;

  y -= 10; drawRule(page, y); y -= 20;

  y = drawSection(page, fonts, y, 'Health Profile');
  y -= 4;
  const healthRows = [
    ['Pregnant/breastfeeding', healthData.health_pregnant_breastfeeding],
    ['Conditions',    healthData.health_conditions === 'Yes' ? healthData.health_conditions_detail : 'None'],
    ['Conditions2',   healthData.health_conditions2 === 'Yes' ? healthData.health_conditions_detail2 : 'None'],
    ['Medications',   healthData.health_medications === 'Yes' ? healthData.health_medications_detail : 'None'],
    ['Allergies',     healthData.health_allergies === 'Yes' ? healthData.health_allergies_detail : 'None'],
    ['Gender',        healthData.health_gender],
    ['Age',           healthData.health_age ? `${healthData.health_age} years` : '—'],
    ['Fasting',       healthData.health_fasting === 'Yes' ? `Yes — ${healthData.health_fasting_detail || ''}` : 'No'],
  ];
  for (const [label, value] of healthRows) {
    y = drawRow(page, fonts, y, label, value || '—');
    if (y < 80) break;
  }

  y -= 10; drawRule(page, y); y -= 20;

  y = drawSection(page, fonts, y, 'Milestone Checklist');
  y -= 4;
  const milestones = [
    '[ ]  DNA kit dispatched to client',
    '[x]  Nutripath payment released — $275.00 — auto-transferred',
    '[x]  Ops payment retained — $95.00 — auto-transferred',
    '[ ]  Client pickup confirmed -> trigger release-payment (pharmacist $140.00)',
    '[ ]  CIL consultation completed -> trigger release-payment (naturopath $65.00)',
    '[x]  Month 2 Stripe auto-debit — $200.00 — subscription created',
  ];
  for (const line of milestones) {
    page.drawText(line, { x: 46, y, size: 9, font: fonts.regular, color: COLORS.ink });
    y -= 16;
  }

  drawFooter(page, fonts, `GeneThrive  |  Ops copy  |  ${clientId}  |  ${orderDate}`);
  return pdfDoc.save();
}

async function generateLabPdf(clientId, healthData, orderDate) {
  const pdfDoc = await PDFDocument.create();
  const page   = pdfDoc.addPage([595, 842]);
  const fonts  = {
    regular: await pdfDoc.embedFont(StandardFonts.Helvetica),
    bold:    await pdfDoc.embedFont(StandardFonts.HelveticaBold),
  };

  let y = drawHeader(page, fonts, 'DNA Test Order — Lab Copy', `${orderDate}  |  ANONYMISED — no client PII`);

  page.drawRectangle({ x: 40, y: y - 36, width: 515, height: 48, color: COLORS.cream });
  page.drawText('CLIENT ID', { x: 52, y: y - 14, size: 8, font: fonts.bold, color: COLORS.sage, characterSpacing: 1 });
  page.drawText(clientId, { x: 52, y: y - 30, size: 20, font: fonts.bold, color: COLORS.ink });
  page.drawText('Use this ID on all correspondence. Do not add client name or address.', {
    x: 240, y: y - 22, size: 8, font: fonts.regular, color: COLORS.soft,
  });
  y -= 58;

  drawRule(page, y); y -= 20;

  y = drawSection(page, fonts, y, 'Health Profile');
  y -= 4;
  const rows = [
    ['Pregnant/breastfeeding', healthData.health_pregnant_breastfeeding],
    ['Conditions',    healthData.health_conditions === 'Yes' ? healthData.health_conditions_detail : 'None'],
    ['Conditions2',   healthData.health_conditions2 === 'Yes' ? healthData.health_conditions_detail2 : 'None'],
    ['Medications',   healthData.health_medications === 'Yes' ? healthData.health_medications_detail : 'None'],
    ['Allergies',     healthData.health_allergies === 'Yes' ? healthData.health_allergies_detail : 'None'],
    ['Gender',        healthData.health_gender],
    ['Age',           healthData.health_age ? `${healthData.health_age} years` : '—'],
    ['Fasting',       healthData.health_fasting === 'Yes' ? `Yes — ${healthData.health_fasting_detail || ''}` : 'No'],
  ];
  for (const [label, value] of rows) {
    y = drawRow(page, fonts, y, label, value || '—');
    if (y < 120) break;
  }

  y -= 10; drawRule(page, y); y -= 20;
  y = drawSection(page, fonts, y, 'Processing Instructions');
  y -= 4;
  const siteUrl = (process.env.SITE_URL || process.env.URL || 'https://genethrive.netlify.app').replace(/\/$/, '');
  const instructions = [
    '1.  Register this test kit using the Client ID above only.',
    '2.  Do not record client name, email, or address in your system.',
    '3.  Return results to GeneThrive referencing the Client ID only.',
    `4.  POST results to: ${siteUrl}/.netlify/functions/dispatch-results`,
  ];
  for (const line of instructions) {
    page.drawText(line, { x: 46, y, size: 9, font: fonts.regular, color: COLORS.ink });
    y -= 16;
  }

  drawFooter(page, fonts, `GeneThrive  |  Lab copy — anonymised  |  ${clientId}`);
  return pdfDoc.save();
}

// ── Email ─────────────────────────────────────────────────────────────────────

function createTransporter() {
  return createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587', 10),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function handler (event) {

  const corsHeaders = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST')   return { statusCode: 405, headers: corsHeaders, body: 'Method not allowed' };

  // Validate env vars upfront
  if (!validateEnv()) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Server configuration error — check Netlify logs' }),
    };
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

  // Parse request
  let paymentIntentId, clientDetails, healthData;
  try {
    const body      = JSON.parse(event.body);
    paymentIntentId = body.paymentIntentId;
    clientDetails   = body.clientDetails;
    healthData      = body.healthData || {};
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

  const customerId = paymentIntent.customer;
  const clientId   = generateClientId(paymentIntentId);
  const orderDate  = new Date().toLocaleDateString('en-AU', { day: '2-digit', month: 'long', year: 'numeric' });

  console.log(`GeneThrive: Finalising order — Client ID ${clientId}`);
  console.log(`GeneThrive: Customer ID — ${customerId}`);

  // ── 2. Transfer $275 to Nutripath ────────────────────────────────────────────
  if (process.env.STRIPE_ACCOUNT_NUTRIPATH) {
    try {
      const t = await stripe.transfers.create({
        amount:      27500,
        currency:    'aud',
        destination: process.env.STRIPE_ACCOUNT_NUTRIPATH,
        description: `GeneThrive ${clientId} — DNA lab payment`,
        metadata:    { clientId },
      });
      console.log(`GeneThrive: $275 transferred to Nutripath — transfer ID ${t.id}`);
    } catch (err) {
      console.error('GeneThrive: Nutripath transfer failed —', err.message);
      console.error('GeneThrive: STRIPE_ACCOUNT_NUTRIPATH value —', process.env.STRIPE_ACCOUNT_NUTRIPATH);
    }
  } else {
    console.warn('GeneThrive: Skipping Nutripath transfer — STRIPE_ACCOUNT_NUTRIPATH not set');
  }

  // ── 3. Transfer $95 to Ops ───────────────────────────────────────────────────
  if (process.env.STRIPE_ACCOUNT_OPS) {
    try {
      const t = await stripe.transfers.create({
        amount:      9500,
        currency:    'aud',
        destination: process.env.STRIPE_ACCOUNT_OPS,
        description: `GeneThrive ${clientId} — ops fee`,
        metadata:    { clientId },
      });
      console.log(`GeneThrive: $95 transferred to Ops — transfer ID ${t.id}`);
    } catch (err) {
      console.error('GeneThrive: Ops transfer failed —', err.message);
      console.error('GeneThrive: STRIPE_ACCOUNT_OPS value —', process.env.STRIPE_ACCOUNT_OPS);
    }
  } else {
    console.warn('GeneThrive: Skipping Ops transfer — STRIPE_ACCOUNT_OPS not set');
  }

  // ── 4. Create $200/month subscription ────────────────────────────────────────
  let subscriptionId = null;
  if (process.env.STRIPE_PRICE_MONTHLY && customerId) {
    try {
      const paymentMethod = paymentIntent.payment_method;
      console.log(`GeneThrive: Payment method — ${paymentMethod}`);

      // Attach payment method to customer
      try {
        await stripe.paymentMethods.attach(paymentMethod, { customer: customerId });
        console.log('GeneThrive: Payment method attached to customer');
      } catch (attachErr) {
        // Already attached is fine
        if (!attachErr.message.includes('already been attached')) {
          throw attachErr;
        }
        console.log('GeneThrive: Payment method already attached — continuing');
      }

      // Set as default + store clientId in metadata
      await stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: paymentMethod },
        metadata: { clientId },
      });
      console.log('GeneThrive: Customer updated with default payment method and clientId');

      // Create subscription with 30-day trial
      const subscription = await stripe.subscriptions.create({
        customer:           customerId,
        items:              [{ price: process.env.STRIPE_PRICE_MONTHLY }],
        trial_period_days:  30,
        metadata:           { clientId, product: 'GeneThrive Monthly Vitamins' },
      });

      subscriptionId = subscription.id;
      console.log(`GeneThrive: Subscription created — ${subscriptionId}`);
    } catch (err) {
      console.error('GeneThrive: Subscription creation failed —', err.message);
      console.error('GeneThrive: STRIPE_PRICE_MONTHLY value —', process.env.STRIPE_PRICE_MONTHLY);
    }
  } else {
    console.warn('GeneThrive: Skipping subscription — STRIPE_PRICE_MONTHLY not set or no customer');
  }

  // ── 5. Create Shopify order ──────────────────────────────────────────────────
  let shopifyOrderNumber = null;
  let shopifyOrderId     = null;
  try {
    console.log(`GeneThrive: Creating Shopify order for ${clientDetails.email}`);

    const shopifyRes = await shopifyFetch(
      '/admin/api/2024-01/orders.json',
      {
        method: 'POST',
        body: JSON.stringify({
          order: {
            email:              clientDetails.email,
            financial_status:   'paid',
            fulfillment_status: null,
            send_receipt:       false,
            send_fulfillment_receipt: false,
            tags:               `stripe-managed,client-id:${clientId},pdf-pending`,
            note:               `Stripe PI: ${paymentIntentId} | Sub: ${subscriptionId || 'pending'}`,
            note_attributes:    Object.entries(healthData).map(([name, value]) => ({ name, value: String(value) })),
            line_items: [{
              title:      'GeneThrive DNA + First Month Vitamins',
              quantity:   1,
              price:      '575.00',
              requires_shipping: false,
            }],
            billing_address: {
              first_name: clientDetails.name.split(' ')[0],
              last_name:  clientDetails.name.split(' ').slice(1).join(' ') || '.',
              address1:   clientDetails.address,
              city:       clientDetails.suburb,
              province:   clientDetails.state,
              zip:        clientDetails.postcode,
              country:    'AU',
              phone:      clientDetails.phone,
            },
            shipping_address: {
              first_name: clientDetails.name.split(' ')[0],
              last_name:  clientDetails.name.split(' ').slice(1).join(' ') || '.',
              address1:   clientDetails.address,
              city:       clientDetails.suburb,
              province:   clientDetails.state,
              zip:        clientDetails.postcode,
              country:    'AU',
              phone:      clientDetails.phone,
            },
          },
        }),
      }
    );

    const shopifyText = await shopifyRes.text();
    let shopifyData;
    try {
      shopifyData = JSON.parse(shopifyText);
    } catch {
      console.error('GeneThrive: Shopify returned non-JSON —', shopifyText.slice(0, 200));
      throw new Error('Non-JSON response from Shopify');
    }

    if (!shopifyRes.ok) {
      console.error('GeneThrive: Shopify order API error — status', shopifyRes.status);
      console.error('GeneThrive: Shopify error details —', JSON.stringify(shopifyData.errors || shopifyData));
    } else {
      shopifyOrderNumber = shopifyData.order?.order_number;
      shopifyOrderId     = shopifyData.order?.id;
      console.log(`GeneThrive: Shopify order #${shopifyOrderNumber} (ID: ${shopifyOrderId}) created for ${clientId}`);
    }
  } catch (err) {
    console.error('GeneThrive: Shopify order creation failed —', err.message);
  }

  // ── 6. Generate PDFs ──────────────────────────────────────────────────────────
  let opsPdfBytes = null;
  let labPdfBytes = null;
  try {
    [opsPdfBytes, labPdfBytes] = await Promise.all([
      generateOpsPdf(clientId, clientDetails, healthData, orderDate),
      generateLabPdf(clientId, healthData, orderDate),
    ]);
    console.log(`GeneThrive: PDFs generated for ${clientId}`);
  } catch (err) {
    console.error('GeneThrive: PDF generation failed —', err.message);
  }

  // ── 7. Send emails ────────────────────────────────────────────────────────────
  try {
    const transporter = createTransporter();
    const firstName   = clientDetails.name.split(' ')[0];

    const emailJobs = [];

    // Ops email
    if (opsPdfBytes) {
      emailJobs.push(
        transporter.sendMail({
          from:    process.env.EMAIL_FROM,
          to:      process.env.EMAIL_OPS,
          replyTo: process.env.EMAIL_REPLY_TO,
          subject: `New Order — ${clientId} — Action Required`,
          html: `<div style="font-family:sans-serif;color:#1c1c1a;max-width:520px">
            <div style="background:#1c1c1a;padding:20px 24px;border-radius:8px 8px 0 0">
              <span style="color:#fff;font-size:16px;font-weight:600;letter-spacing:2px">GENETHRIVE</span>
            </div>
            <div style="border:1px solid #d6cfc3;border-top:none;padding:24px;border-radius:0 0 8px 8px">
              <p style="margin:0 0 12px">New order received and paid via Stripe.</p>
              <div style="background:#f7f4ee;border-radius:6px;padding:14px;margin-bottom:16px">
                <div style="font-size:10px;color:#4a6741;font-weight:600;letter-spacing:1px;margin-bottom:4px">CLIENT ID</div>
                <div style="font-size:20px;font-weight:700">${clientId}</div>
              </div>
              <p style="font-size:13px;font-weight:600;margin:0 0 8px">Immediate actions:</p>
              <ol style="font-size:13px;color:#4a4a46;line-height:1.8;margin:0 0 16px;padding-left:18px">
                <li>$275 auto-transferred to Nutripath</li>
                <li>$95 auto-transferred to Ops</li>
                <li>$200/mo subscription created</li>
                <li>Dispatch DNA kit to client</li>
                <li>Trigger pharmacist release ($140) after pickup</li>
                <li>Trigger naturopath release ($65) after CIL</li>
              </ol>
              <p style="font-size:13px;color:#7a7a74">Full details in attached PDF.</p>
            </div>
          </div>`,
          attachments: [{
            filename:    `GeneThrive-Order-${clientId}.pdf`,
            content:     Buffer.from(opsPdfBytes),
            contentType: 'application/pdf',
          }],
        })
      );
    }

    // Lab email
    if (labPdfBytes) {
      emailJobs.push(
        transporter.sendMail({
          from:    process.env.EMAIL_FROM,
          to:      process.env.EMAIL_LAB,
          replyTo: process.env.EMAIL_REPLY_TO,
          subject: `New DNA Test Order — ${clientId}`,
          html: `<div style="font-family:sans-serif;color:#1c1c1a;max-width:520px">
            <div style="background:#4a6741;padding:20px 24px;border-radius:8px 8px 0 0">
              <span style="color:#fff;font-size:16px;font-weight:600;letter-spacing:2px">GENETHRIVE</span>
            </div>
            <div style="border:1px solid #d6cfc3;border-top:none;padding:24px;border-radius:0 0 8px 8px">
              <div style="background:#f7f4ee;border-radius:6px;padding:14px;margin-bottom:16px">
                <div style="font-size:10px;color:#4a6741;font-weight:600;letter-spacing:1px;margin-bottom:4px">CLIENT ID</div>
                <div style="font-size:20px;font-weight:700">${clientId}</div>
              </div>
              <p style="font-size:13px;color:#4a4a46;margin:0 0 12px">Process using the Client ID only. Do not record personal details.</p>
              <p style="font-size:13px;color:#7a7a74">See attached PDF for health profile and processing instructions.</p>
            </div>
          </div>`,
          attachments: [{
            filename:    `GeneThrive-Lab-${clientId}.pdf`,
            content:     Buffer.from(labPdfBytes),
            contentType: 'application/pdf',
          }],
        })
      );
    }

    // Client confirmation
    emailJobs.push(
      transporter.sendMail({
        from:    process.env.EMAIL_FROM,
        to:      clientDetails.email,
        replyTo: process.env.EMAIL_REPLY_TO,
        subject: `Your GeneThrive order is confirmed — ${clientId}`,
        html: `<div style="font-family:sans-serif;color:#1c1c1a;max-width:520px">
          <div style="background:#4a6741;padding:20px 24px;border-radius:8px 8px 0 0">
            <span style="color:#fff;font-size:16px;font-weight:600;letter-spacing:2px">GENETHRIVE</span>
          </div>
          <div style="border:1px solid #d6cfc3;border-top:none;padding:28px;border-radius:0 0 8px 8px">
            <h2 style="margin:0 0 14px;font-size:20px">Thank you, ${firstName}!</h2>
            <p style="margin:0 0 16px;font-size:14px;color:#4a4a46;line-height:1.6">
              Your payment of <strong>$575.00</strong> has been received.
              Your DNA test kit will be dispatched shortly.
            </p>
            <div style="background:#e8eee7;border-radius:8px;padding:16px;margin-bottom:20px">
              <div style="font-size:10px;color:#4a6741;font-weight:600;letter-spacing:1px;margin-bottom:4px">YOUR REFERENCE</div>
              <div style="font-size:18px;font-weight:700">${clientId}</div>
              <div style="font-size:12px;color:#7a7a74;margin-top:4px">Keep this for any enquiries</div>
            </div>
            <p style="font-size:13px;font-weight:600;margin:0 0 10px">What happens next:</p>
            <ol style="font-size:13px;color:#4a4a46;line-height:1.8;margin:0 0 20px;padding-left:18px">
              <li>DNA test kit arrives in 3-5 business days</li>
              <li>Complete your sample and return it using the prepaid envelope</li>
              <li>Our naturopath reviews your results and health profile</li>
              <li>Your personalised vitamins are compounded and dispatched</li>
              <li>Your <strong>$200/month</strong> subscription begins 30 days from today</li>
            </ol>
            <p style="font-size:13px;color:#7a7a74;margin:0">
              Questions? Contact us at
              <a href="mailto:${process.env.EMAIL_REPLY_TO}" style="color:#4a6741">
                ${process.env.EMAIL_REPLY_TO}
              </a>
            </p>
          </div>
        </div>`,
      })
    );

    await Promise.all(emailJobs);
    console.log(`GeneThrive: All emails sent for ${clientId}`);
  } catch (err) {
    console.error('GeneThrive: Email sending failed —', err.message);
  }

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
}