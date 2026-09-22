/**
 * GeneThrive — Partner Status Ping
 * ─────────────────────────────────────────────────────────────────────────────
 * Netlify Function: netlify/functions/partner-status.js
 *
 * CALLED BY: nutripath-status.html and tsi-status.html
 *
 * WHAT IT DOES:
 *   Receives a status ping from NutriPath or TSI and updates the
 *   order_sla table in Supabase. NO clinical content ever stored here.
 *
 * SUPPORTED STATUS EVENTS:
 *   NutriPath:
 *     - kit_dispatched       → order_sla.kit_dispatched_at
 *     - swab_returned        → order_sla.swab_returned_at
 *   TSI:
 *     - script_opened        → order_sla.tsi_script_opened_at
 *     - vitamins_shipped     → order_sla.tsi_shipped_at
 *                            → triggers client notification email + follow-up timers
 *
 * ENVIRONMENT VARIABLES:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   PARTNER_TOKEN_SECRET (shared with partner-auth.js)
 *   SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_TOKEN
 *   SMTP_HOST/PORT/USER/PASS, EMAIL_FROM, EMAIL_OPS, EMAIL_REPLY_TO
 * ─────────────────────────────────────────────────────────────────────────────
 */

const crypto     = require('crypto');
const nodemailer = require('nodemailer');
const { shopifyFetch } = require('./shopify-token');
const { advanceStage } = require('./sla-stage');

function verifyToken(token) {
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const parts   = decoded.split(':');
    if (parts.length !== 3) return null;
    const [partner, expires, sig] = parts;
    if (Date.now() > parseInt(expires)) return null;
    const expected = crypto
      .createHmac('sha256', process.env.PARTNER_TOKEN_SECRET || 'fallback')
      .update(`${partner}:${expires}`)
      .digest('hex');
    if (sig !== expected) return null;
    return partner;
  } catch { return null; }
}

function createTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

async function supabasePatch(clientId, fields) {
  const res = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/order_sla?client_id=eq.${encodeURIComponent(clientId)}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type':  'application/json',
        'apikey':        process.env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        'Prefer':        'return=minimal',
      },
      body: JSON.stringify(fields),
    }
  );
  return { ok: res.ok, status: res.status };
}

async function supabaseGet(clientId) {
  const res = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/order_sla?client_id=eq.${encodeURIComponent(clientId)}&limit=1`,
    {
      headers: {
        'apikey':        process.env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      },
    }
  );
  const data = await res.json();
  return data?.[0] || null;
}

exports.handler = async function (event) {

  const corsHeaders = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Partner-Token',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST')   return { statusCode: 405, headers: corsHeaders, body: 'Method not allowed' };

  // Verify partner token
  const token   = event.headers['x-partner-token'];
  const partner = verifyToken(token);

  if (!partner) {
    return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  // Parse request
  let clientId, statusEvent, notes, trackingNumber;
  try {
    const body    = JSON.parse(event.body);
    clientId      = body.clientId?.trim();
    statusEvent   = body.statusEvent;
    notes         = body.notes || '';
    trackingNumber = body.trackingNumber || '';
  } catch {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  if (!clientId || !statusEvent) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing clientId or statusEvent' }) };
  }

  const now = new Date().toISOString();

  // Validate event matches partner
  const nutriPathEvents = ['kit_dispatched', 'swab_returned'];
  const tsiEvents       = ['script_opened', 'vitamins_shipped'];

  if (partner === 'nutripath' && !nutriPathEvents.includes(statusEvent)) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: `Invalid event for NutriPath: ${statusEvent}` }) };
  }
  if (partner === 'tsi' && !tsiEvents.includes(statusEvent)) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: `Invalid event for TSI: ${statusEvent}` }) };
  }

  // Map event to Supabase field
  const fieldMap = {
    kit_dispatched:   { kit_dispatched_at: now },
    swab_returned:    { swab_returned_at: now },
    script_opened:    { tsi_script_opened_at: now },
    vitamins_shipped: { tsi_shipped_at: now },
  };

  const fields = fieldMap[statusEvent];

  // Also set follow-up dates when vitamins ship
  if (statusEvent === 'vitamins_shipped') {
    const shipDate = new Date();
    fields.follow_up_12wk_due_at = new Date(shipDate.getTime() + 84 * 24 * 60 * 60 * 1000).toISOString();
    fields.follow_up_6mo_due_at  = new Date(shipDate.getTime() + 180 * 24 * 60 * 60 * 1000).toISOString();
  }

  // Update Supabase
  const updateRes = await supabasePatch(clientId, fields);
  if (!updateRes.ok && updateRes.status !== 204) {
    console.error('GeneThrive partner-status: Supabase update failed —', updateRes.status);
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Could not update status' }) };
  }

  console.log(`GeneThrive partner-status: ${partner} → ${statusEvent} for ${clientId}`);

  // When swab returned
  await advanceStage(clientId, 'swab_return');
  // When DNA results submitted
  await advanceStage(clientId, 'sequencing');

  // Update Shopify order tag
  try {
    const tagMap = {
      kit_dispatched:   'kit-dispatched',
      swab_returned:    'swab-returned',
      script_opened:    'tsi-script-opened',
      vitamins_shipped: 'vitamins-dispatched',
    };
    const newTag  = tagMap[statusEvent];
    const res     = await shopifyFetch(
      `/admin/api/2024-01/orders.json?tag=client-id:${encodeURIComponent(clientId)}&status=any&limit=1`
    );
    const data    = await res.json();
    const order   = data.orders?.[0];
    if (order && newTag) {
      const tags = (order.tags || '').split(', ').filter(Boolean).concat([newTag]);
      await shopifyFetch(`/admin/api/2024-01/orders/${order.id}.json`, {
        method: 'PUT',
        body:   JSON.stringify({ order: { id: order.id, tags: tags.join(', ') } }),
      });
    }
  } catch (err) {
    console.warn('GeneThrive partner-status: Shopify tag update failed —', err.message);
  }

  // Send notification email for key events
  if (['kit_dispatched', 'vitamins_shipped'].includes(statusEvent)) {
    try {
      const slaRow      = await supabaseGet(clientId);
      const transporter = createTransporter();

      if (statusEvent === 'kit_dispatched') {
        // Ops notification only
        await transporter.sendMail({
          from:    process.env.EMAIL_FROM,
          to:      process.env.EMAIL_OPS,
          replyTo: process.env.EMAIL_REPLY_TO,
          subject: `Kit dispatched — ${clientId}`,
          html: `<div style="font-family:sans-serif;max-width:420px;padding:24px;color:#1c1c1a">
            <strong>GeneThrive</strong><br><br>
            NutriPath has confirmed the DNA swab kit has been dispatched for <strong>${clientId}</strong>.<br><br>
            SLA: Swab should be returned within 7 working days.
          </div>`,
        });
      }

      if (statusEvent === 'vitamins_shipped') {
        // Email client — vitamins on their way
        if (slaRow?.client_email) {
          await transporter.sendMail({
            from:    process.env.EMAIL_FROM,
            to:      slaRow.client_email,
            replyTo: process.env.EMAIL_REPLY_TO,
            subject: `Your GeneThrive vitamins are on their way — ${clientId}`,
            html: `<div style="font-family:sans-serif;max-width:520px;color:#1c1c1a">
              <div style="background:#4a6741;padding:20px 24px;border-radius:8px 8px 0 0">
                <span style="color:#fff;font-size:16px;font-weight:600;letter-spacing:2px">GENETHRIVE</span>
              </div>
              <div style="border:1px solid #d6cfc3;border-top:none;padding:28px;border-radius:0 0 8px 8px">
                <h2 style="margin:0 0 14px;font-size:18px;font-weight:500">Your vitamins are on their way!</h2>
                <p style="font-size:14px;color:#4a4a46;line-height:1.6;margin:0 0 16px">
                  Your personalised vitamin formula has been compounded and dispatched.
                  Allow 3–5 business days for delivery.
                </p>
                <div style="background:#e8eee7;border-radius:8px;padding:14px;margin-bottom:16px">
                  <div style="font-size:10px;color:#4a6741;font-weight:600;letter-spacing:1px;margin-bottom:4px">REFERENCE</div>
                  <div style="font-size:16px;font-weight:700">${clientId}</div>
                  ${trackingNumber ? `<div style="font-size:12px;color:#7a7a74;margin-top:4px">Tracking: ${trackingNumber}</div>` : ''}
                </div>
                ${notes ? `<p style="font-size:13px;color:#4a4a46;margin:0 0 16px"><strong>Note:</strong> ${notes}</p>` : ''}
                <p style="font-size:13px;color:#7a7a74">
                  Questions? <a href="mailto:${process.env.EMAIL_REPLY_TO}" style="color:#4a6741">${process.env.EMAIL_REPLY_TO}</a>
                </p>
              </div>
            </div>`,
          });
        }

        // Ops notification
        await transporter.sendMail({
          from:    process.env.EMAIL_FROM,
          to:      process.env.EMAIL_OPS,
          replyTo: process.env.EMAIL_REPLY_TO,
          subject: `Vitamins shipped — ${clientId} — follow-up timers started`,
          html: `<div style="font-family:sans-serif;max-width:420px;padding:24px;color:#1c1c1a">
            <strong>GeneThrive</strong><br><br>
            TSI has confirmed vitamins shipped for <strong>${clientId}</strong>.<br>
            ${trackingNumber ? `Tracking: ${trackingNumber}<br>` : ''}
            12-week follow-up SMS due in 12 weeks.<br>
            6-month follow-up SMS due in 6 months.
          </div>`,
        });
      }
    } catch (err) {
      console.error('GeneThrive partner-status: Email failed —', err.message);
    }
  }

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({
      success: true,
      clientId,
      statusEvent,
      message: `${statusEvent} recorded for ${clientId}`,
    }),
  };
};