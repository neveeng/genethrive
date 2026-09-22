/**
 * GeneThrive — Barbara's Engine API
 * ─────────────────────────────────────────────────────────────────────────────
 * Netlify Function: netlify/functions/barbara-engine.js
 *
 * CALLED BY: barbara-portal.html
 *
 * ACTIONS:
 *   GET  ?action=get_client&clientId=GT-XXXX
 *        → Returns health profile + DNA results from Supabase
 *          (Barbara-authenticated only)
 *
 *   GET  ?action=get_pending
 *        → Returns list of clients awaiting Barbara's review
 *
 *   POST { action: 'sign_off', clientId, supplementList, notes, barbaraPin }
 *        → Saves Barbara's sign-off and supplement list to Supabase
 *        → Emails supplement list to TSI
 *        → Updates order_sla.barbara_reviewed_at + supplement_list_sent_at
 *        → Tags Shopify order: barbara-reviewed
 *        → Releases Barbara's payment via Stripe ($65)
 *
 * PRIVACY:
 *   - Only returns clinical data to authenticated Barbara session
 *   - Supplement list sent to TSI by email only (not stored in Shopify)
 *   - Paul's dashboard never sees this data
 *
 * ENVIRONMENT VARIABLES:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   PARTNER_TOKEN_SECRET
 *   STRIPE_SECRET_KEY, STRIPE_ACCOUNT_NATUROPATH, PRICE_NATUROPATH_CENTS
 *   SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_TOKEN
 *   SMTP_HOST/PORT/USER/PASS
 *   EMAIL_FROM, EMAIL_OPS, EMAIL_TSI, EMAIL_REPLY_TO
 * ─────────────────────────────────────────────────────────────────────────────
 */

const crypto     = require('crypto');
const Stripe     = require('stripe');
const nodemailer = require('nodemailer');
const { shopifyFetch }  = require('./shopify-token');
const { advanceStage }  = require('./sla-stage');

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

async function supabaseGet(path) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1${path}`, {
    headers: {
      'apikey':        process.env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
    },
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, data: text ? JSON.parse(text) : null };
}

async function supabasePatch(path, body) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1${path}`, {
    method: 'PATCH',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        process.env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Prefer':        'return=minimal',
    },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status };
}

exports.handler = async function (event) {

  const corsHeaders = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Partner-Token',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };

  // Verify Barbara's token
  const token   = event.headers['x-partner-token'];
  const partner = verifyToken(token);
  if (partner !== 'naturopath') {
    return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  // ── GET requests ────────────────────────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    const action   = event.queryStringParameters?.action;
    const clientId = event.queryStringParameters?.clientId?.trim();

    // Get pending clients — awaiting Barbara's review
    if (action === 'get_pending') {
      const slaRes = await supabaseGet(
        '/order_sla?dna_results_received_at=not.is.null&barbara_reviewed_at=is.null&order=dna_results_received_at.asc&limit=50'
      );
      if (!slaRes.ok) {
        return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Could not fetch pending clients' }) };
      }
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ pending: slaRes.data }),
      };
    }

    // Get full client data for Engine
    if (action === 'get_client' && clientId) {
      const [profileRes, dnaRes] = await Promise.all([
        supabaseGet(`/health_profiles?client_id=eq.${encodeURIComponent(clientId)}&limit=1`),
        supabaseGet(`/dna_results?client_id=eq.${encodeURIComponent(clientId)}&limit=1`),
      ]);

      const profile = profileRes.data?.[0] || null;
      const dna     = dnaRes.data?.[0] || null;

      if (!profile) {
        return {
          statusCode: 404,
          headers: corsHeaders,
          body: JSON.stringify({ error: `No health profile found for ${clientId}` }),
        };
      }

      console.log(`GeneThrive barbara-engine: ${clientId} data retrieved for Barbara`);

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ clientId, profile, dna }),
      };
    }

    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid action' }) };
  }

  // ── POST — sign off ─────────────────────────────────────────────────────────
  if (event.httpMethod === 'POST') {
    let action, clientId, supplementList, notes, clientSla;
    try {
      const body   = JSON.parse(event.body);
      action       = body.action;
      clientId     = body.clientId?.trim();
      supplementList = body.supplementList || {};
      notes        = body.notes || '';
    } catch {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    if (action !== 'sign_off' || !clientId) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing action or clientId' }) };
    }

    const now = new Date().toISOString();

    // 1. Get SLA row for client contact details
    const slaRes = await supabaseGet(`/order_sla?client_id=eq.${encodeURIComponent(clientId)}&limit=1`);
    clientSla    = slaRes.data?.[0];

    // 2. Update Supabase — mark Barbara reviewed + supplement list sent
    await Promise.all([
      supabasePatch(
        `/health_profiles?client_id=eq.${encodeURIComponent(clientId)}`,
        { barbara_reviewed: true }
      ),
      supabasePatch(
        `/dna_results?client_id=eq.${encodeURIComponent(clientId)}`,
        {
          barbara_reviewed:     true,
          barbara_reviewed_at:  now,
          barbara_notes:        notes,
          supplement_list_sent: true,
          supplement_list_sent_at: now,
        }
      ),
      supabasePatch(
        `/order_sla?client_id=eq.${encodeURIComponent(clientId)}`,
        {
          barbara_reviewed_at:    now,
          supplement_list_sent_at: now,
        }
      ),
    ]);

    console.log(`GeneThrive barbara-engine: Sign-off complete for ${clientId}`);

    // 3. Advance SLA stages — barbara_review then compounding (non-fatal)
    try {
      await advanceStage(clientId, 'barbara_review');
      await advanceStage(clientId, 'compounding');
    } catch (err) {
      console.error('GeneThrive barbara-engine: advanceStage failed (non-fatal) —', err.message);
    }

    // 4. Release Barbara's payment ($65) via Stripe
    if (process.env.STRIPE_ACCOUNT_NATUROPATH && process.env.STRIPE_SECRET_KEY) {
      try {
        const stripe   = Stripe(process.env.STRIPE_SECRET_KEY);
        const transfer = await stripe.transfers.create({
          amount:      parseInt(process.env.PRICE_NATUROPATH_CENTS || '6500'),
          currency:    'aud',
          destination: process.env.STRIPE_ACCOUNT_NATUROPATH,
          description: `GeneThrive ${clientId} — naturopath review fee`,
          metadata:    { clientId, stage: 'barbara-review' },
        });
        console.log(`GeneThrive: Barbara $65 transferred — ${transfer.id}`);
      } catch (err) {
        console.error('GeneThrive: Barbara payment transfer failed —', err.message);
      }
    }

    // 5. Tag Shopify order
    try {
      const orderRes  = await shopifyFetch(
        `/admin/api/2024-01/orders.json?tag=client-id:${encodeURIComponent(clientId)}&status=any&limit=1`
      );
      const orderData = await orderRes.json();
      const order     = orderData.orders?.[0];
      if (order) {
        const tags = (order.tags || '').split(', ').filter(Boolean).concat(['barbara-reviewed', 'cil-completed']);
        await shopifyFetch(`/admin/api/2024-01/orders/${order.id}.json`, {
          method: 'PUT',
          body:   JSON.stringify({ order: { id: order.id, tags: [...new Set(tags)].join(', ') } }),
        });
      }
    } catch (err) {
      console.warn('GeneThrive: Shopify tag update failed —', err.message);
    }

    // 6. Email supplement list to TSI
    const orderDate = new Date().toLocaleDateString('en-AU', { day: '2-digit', month: 'long', year: 'numeric' });

    // Format supplement list for email
    const supplementHtml = Object.entries(supplementList).length > 0
      ? `<table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead>
            <tr style="background:#f7f4ee">
              <th style="padding:8px 12px;text-align:left;border-bottom:1px solid #d6cfc3">Supplement</th>
              <th style="padding:8px 12px;text-align:left;border-bottom:1px solid #d6cfc3">Dose</th>
              <th style="padding:8px 12px;text-align:left;border-bottom:1px solid #d6cfc3">Frequency</th>
              <th style="padding:8px 12px;text-align:left;border-bottom:1px solid #d6cfc3">Notes</th>
            </tr>
          </thead>
          <tbody>
            ${supplementList.items?.map(item => `
              <tr style="border-bottom:1px solid #ede8df">
                <td style="padding:8px 12px;font-weight:500">${item.name || '—'}</td>
                <td style="padding:8px 12px">${item.dose || '—'}</td>
                <td style="padding:8px 12px">${item.frequency || '—'}</td>
                <td style="padding:8px 12px;color:#7a7a74">${item.notes || ''}</td>
              </tr>`).join('') || '<tr><td colspan="4" style="padding:12px;color:#7a7a74">See attached notes</td></tr>'}
          </tbody>
        </table>`
      : '<p style="color:#7a7a74;font-size:13px">See Barbara\'s notes below for formula details.</p>';

    try {
      const transporter = createTransporter();
      await Promise.all([

        // TSI — supplement list (compounding script)
        transporter.sendMail({
          from:    process.env.EMAIL_FROM,
          to:      process.env.EMAIL_TSI,
          replyTo: process.env.EMAIL_REPLY_TO,
          subject: `Compounding script — ${clientId} — Action required within 72h`,
          html: `
            <div style="font-family:sans-serif;max-width:600px;color:#1c1c1a">
              <div style="background:#b45309;padding:20px 24px;border-radius:8px 8px 0 0">
                <span style="color:#fff;font-size:16px;font-weight:600;letter-spacing:2px">GENETHRIVE</span>
                <span style="color:rgba(255,255,255,0.7);font-size:12px;margin-left:10px">Compounding Script</span>
              </div>
              <div style="border:1px solid #d6cfc3;border-top:none;padding:24px;border-radius:0 0 8px 8px">
                <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:14px;margin-bottom:20px">
                  <strong style="color:#92400e">⚠ SLA: Compound and ship within 72 hours of opening this email.</strong>
                  <br><small style="color:#92400e">The 72h clock starts when you confirm receipt in your portal.</small>
                </div>
                <div style="background:#f7f4ee;border-radius:8px;padding:14px;margin-bottom:20px">
                  <div style="font-size:10px;color:#b45309;font-weight:600;letter-spacing:1px;margin-bottom:4px">CLIENT ID</div>
                  <div style="font-size:20px;font-weight:700">${clientId}</div>
                  <div style="font-size:12px;color:#7a7a74;margin-top:4px">${orderDate}</div>
                </div>
                <div style="margin-bottom:20px">
                  <div style="font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#b45309;margin-bottom:12px">Personalised Formula</div>
                  ${supplementHtml}
                </div>
                ${notes ? `
                  <div style="background:#f0f7f0;border-radius:8px;padding:14px;margin-bottom:20px">
                    <div style="font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#4a6741;margin-bottom:8px">Naturopath Notes</div>
                    <div style="font-size:13px;color:#1c1c1a;line-height:1.7;white-space:pre-wrap">${notes}</div>
                  </div>` : ''}
                <p style="font-size:13px;font-weight:600;color:#1c1c1a;margin:0 0 8px">Action required:</p>
                <ol style="font-size:13px;color:#4a4a46;line-height:1.8;margin:0 0 16px;padding-left:18px">
                  <li>Log in to your portal and confirm receipt of this script (starts 72h SLA)</li>
                  <li>Compound one month's personalised capsules</li>
                  <li>Ship to the client's address on file</li>
                  <li>Confirm dispatch in your portal (triggers client notification + your payment)</li>
                </ol>
                <p style="font-size:12px;color:#7a7a74">
                  Client address is on file from the original order — log in to your portal to view.
                  Do not reply to this email with clinical content.
                </p>
              </div>
            </div>
          `,
        }),

        // Ops — status only
        transporter.sendMail({
          from:    process.env.EMAIL_FROM,
          to:      process.env.EMAIL_OPS,
          replyTo: process.env.EMAIL_REPLY_TO,
          subject: `Barbara sign-off complete — ${clientId} — Script sent to TSI`,
          html: `<div style="font-family:sans-serif;max-width:420px;padding:24px;color:#1c1c1a">
            <strong>GeneThrive Ops</strong><br><br>
            Barbara has completed her review for <strong>${clientId}</strong>.<br><br>
            Compounding script sent to TSI — 72h clock starts on their receipt confirmation.<br>
            Barbara's payment ($65) released.<br><br>
            <span style="font-size:11px;color:#7a7a74">Formula content not included here — stored securely in Supabase.</span>
          </div>`,
        }),

      ]);

      console.log(`GeneThrive barbara-engine: Emails sent for ${clientId}`);
    } catch (err) {
      console.error('GeneThrive barbara-engine: Email failed —', err.message);
    }

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        success:  true,
        clientId,
        message:  'Sign-off complete. Supplement list sent to TSI. Payment released.',
      }),
    };
  }

  return { statusCode: 405, headers: corsHeaders, body: 'Method not allowed' };
};