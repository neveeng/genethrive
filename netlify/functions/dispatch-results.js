/**
 * GeneThrive — DNA Results Received → Partner PDF Dispatch
 * ─────────────────────────────────────────────────────────────────────────────
 * Netlify Function: netlify/functions/dispatch-results.js
 *
 * TRIGGERED BY: DNA lab POSTing results to this webhook URL
 *
 * WHAT IT DOES:
 *   1. Lab POSTs JSON with clientId + results summary
 *   2. Function verifies the request using a shared secret key
 *   3. Looks up the original Shopify order using the Client ID tag
 *   4. Reads health data from order attributes
 *   5. Generates 3 partner PDFs:
 *        - Nutripath PDF   (results + formula brief)
 *        - Pharmacist PDF  (compounding instructions)
 *        - Naturopath PDF  (CIL review package)
 *   6. Emails each PDF to the relevant partner
 *   7. Sends client a "your results are ready" notification email
 *   8. Tags the Shopify order as results-dispatched
 *
 * WEBHOOK URL TO GIVE THE LAB:
 *   https://genethrive.netlify.app/.netlify/functions/dispatch-results
 *
 * WHAT THE LAB MUST POST (JSON body):
 *   {
 *     "clientId":   "GT-1042-a3f9c2",
 *     "results":    "Brief plain-text summary of DNA findings",
 *     "reportUrl":  "https://lab-portal.com/report/abc123"  (optional)
 *   }
 *
 * AUTHENTICATION:
 *   The lab must include a secret key in the request header:
 *     X-GeneThrive-Secret: <value of LAB_WEBHOOK_SECRET env var>
 *   Share this secret with the lab securely (e.g. via 1Password or email).
 *
 * ENVIRONMENT VARIABLES (add to Netlify + .env):
 *   LAB_WEBHOOK_SECRET       = a strong random string you share with the lab
 *   SHOPIFY_STORE_DOMAIN     = your-store.myshopify.com
 *   SHOPIFY_ADMIN_TOKEN      = shpat_xxxxxxxxxxxxxxxxxxxx
 *   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS  (same as process-order.js)
 *   EMAIL_FROM               = GeneThrive Orders <orders@genethrive.com>
 *   EMAIL_REPLY_TO           = support@genethrive.com
 *   EMAIL_NUTRIPATH          = lab@nutripath.com.au
 *   EMAIL_PHARMACIST         = compounding@pharmacy.com.au
 *   EMAIL_NATUROPATH         = consult@naturopath.com.au
 *   EMAIL_OPS                = ops@genethrive.com
 *
 * GENERATE A STRONG SECRET (run in terminal, copy the output):
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 * ─────────────────────────────────────────────────────────────────────────────
 */

const nodemailer = require('nodemailer');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

// ── PDF helpers (shared style with process-order.js) ─────────────────────────

const COLORS = {
  sage:   rgb(0.29, 0.40, 0.25),
  ink:    rgb(0.11, 0.11, 0.10),
  soft:   rgb(0.48, 0.48, 0.45),
  border: rgb(0.84, 0.81, 0.76),
  cream:  rgb(0.97, 0.96, 0.93),
  white:  rgb(1, 1, 1),
  amber:  rgb(0.69, 0.54, 0.31),
  teal:   rgb(0.18, 0.56, 0.51),
};

function drawRule(page, y, { width = 515, x = 40, color = COLORS.border } = {}) {
  page.drawLine({ start: { x, y }, end: { x: x + width, y }, thickness: 0.5, color });
}

function drawRow(page, fonts, y, label, value) {
  page.drawText(label, { x: 40, y, size: 10, font: fonts.regular, color: COLORS.soft });
  page.drawText(String(value || '—'), { x: 220, y, size: 10, font: fonts.regular, color: COLORS.ink, maxWidth: 330 });
  return y - 18;
}

function drawSectionHeading(page, fonts, y, text) {
  page.drawRectangle({ x: 40, y: y - 4, width: 515, height: 20, color: COLORS.cream });
  page.drawText(text.toUpperCase(), { x: 46, y, size: 8, font: fonts.bold, color: COLORS.sage, characterSpacing: 1 });
  return y - 26;
}

function drawHeader(page, fonts, title, subtitle, accentColor = COLORS.sage) {
  page.drawRectangle({ x: 0, y: 782, width: 595, height: 60, color: accentColor });
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

function drawClientIdBlock(page, fonts, y, clientId) {
  page.drawRectangle({ x: 40, y: y - 36, width: 515, height: 48, color: COLORS.cream });
  page.drawText('CLIENT ID', { x: 52, y: y - 14, size: 8, font: fonts.bold, color: COLORS.sage, characterSpacing: 1 });
  page.drawText(clientId, { x: 52, y: y - 30, size: 20, font: fonts.bold, color: COLORS.ink });
  return y - 58;
}

async function makeDoc() {
  const pdfDoc = await PDFDocument.create();
  const page   = pdfDoc.addPage([595, 842]);
  const fonts  = {
    regular: await pdfDoc.embedFont(StandardFonts.Helvetica),
    bold:    await pdfDoc.embedFont(StandardFonts.HelveticaBold),
  };
  return { pdfDoc, page, fonts };
}

// ── PDF 1: Nutripath ─────────────────────────────────────────────────────────

async function generateNutripathPdf(clientId, results, health, orderDate, reportUrl) {
  const { pdfDoc, page, fonts } = await makeDoc();

  let y = drawHeader(page, fonts,
    'DNA Results — Nutripath Formula Brief',
    `Client ID: ${clientId}  ·  Results received: ${orderDate}`
  );

  y = drawClientIdBlock(page, fonts, y, clientId);
  y -= 10;

  y = drawSectionHeading(page, fonts, y, 'DNA Results Summary');
  y -= 4;

  // Results text — word-wrapped manually in chunks
  const lines = wrapText(results, 85);
  for (const line of lines) {
    page.drawText(line, { x: 46, y, size: 10, font: fonts.regular, color: COLORS.ink });
    y -= 16;
    if (y < 120) break;
  }

  if (reportUrl) {
    y -= 6;
    page.drawText(`Full report: ${reportUrl}`, { x: 46, y, size: 9, font: fonts.regular, color: COLORS.teal });
    y -= 20;
  }

  y -= 10;
  drawRule(page, y);
  y -= 20;

  y = drawSectionHeading(page, fonts, y, 'Client Health Profile');
  y -= 4;
  y = drawRow(page, fonts, y, 'Age',                   health.age ? `${health.age} years` : '—');
  y = drawRow(page, fonts, y, 'Gender',                health.gender);
  y = drawRow(page, fonts, y, 'Conditions',            health.conditions === 'Yes' ? health.conditions_detail : 'None');
  y = drawRow(page, fonts, y, 'Medications',           health.medications === 'Yes' ? health.medications_detail : 'None');
  y = drawRow(page, fonts, y, 'Allergies',             health.allergies === 'Yes' ? health.allergies_detail : 'None');
  y = drawRow(page, fonts, y, 'Pregnant/breastfeed',  health.pregnant_breastfeeding);
  y = drawRow(page, fonts, y, 'Fasting',               health.fasting === 'Yes' ? `Yes — ${health.fasting_detail || 'protocol not specified'}` : 'No');

  y -= 10;
  drawRule(page, y);
  y -= 20;

  y = drawSectionHeading(page, fonts, y, 'Action Required');
  y -= 4;

  const actions = [
    '1.  Review DNA results and health profile above.',
    '2.  Prepare personalised vitamin formula brief.',
    '3.  Forward compounding instructions to GeneThrive pharmacist.',
    '4.  Notify GeneThrive ops once formula brief is complete.',
  ];
  for (const line of actions) {
    page.drawText(line, { x: 46, y, size: 9, font: fonts.regular, color: COLORS.ink });
    y -= 16;
  }

  drawFooter(page, fonts, `GeneThrive  ·  Nutripath copy  ·  ${clientId}  ·  ${orderDate}`);
  return pdfDoc.save();
}

// ── PDF 2: Pharmacist ─────────────────────────────────────────────────────────

async function generatePharmacistPdf(clientId, results, health, orderDate) {
  const { pdfDoc, page, fonts } = await makeDoc();

  let y = drawHeader(page, fonts,
    'Compounding Instructions — Pharmacist',
    `Client ID: ${clientId}  ·  ${orderDate}`,
    rgb(0.25, 0.35, 0.55)
  );

  y = drawClientIdBlock(page, fonts, y, clientId);
  y -= 10;

  y = drawSectionHeading(page, fonts, y, 'DNA Results Summary');
  y -= 4;
  const lines = wrapText(results, 85);
  for (const line of lines) {
    page.drawText(line, { x: 46, y, size: 10, font: fonts.regular, color: COLORS.ink });
    y -= 16;
    if (y < 160) break;
  }

  y -= 10;
  drawRule(page, y);
  y -= 20;

  y = drawSectionHeading(page, fonts, y, 'Client Contraindications');
  y -= 4;
  y = drawRow(page, fonts, y, 'Allergies',       health.allergies === 'Yes' ? health.allergies_detail : 'None reported');
  y = drawRow(page, fonts, y, 'Medications',     health.medications === 'Yes' ? health.medications_detail : 'None reported');
  y = drawRow(page, fonts, y, 'Conditions',      health.conditions === 'Yes' ? health.conditions_detail : 'None reported');
  y = drawRow(page, fonts, y, 'Pregnant/BF',     health.pregnant_breastfeeding || '—');
  y = drawRow(page, fonts, y, 'Age / Gender',    `${health.age || '—'} years  ·  ${health.gender || '—'}`);

  y -= 10;
  drawRule(page, y);
  y -= 20;

  y = drawSectionHeading(page, fonts, y, 'Compounding Notes');
  y -= 4;

  const notes = [
    '·  Await formula brief from Nutripath before commencing compounding.',
    '·  Cross-reference all ingredients against client contraindications above.',
    '·  Payment of $140.00 released to you upon client pickup confirmation.',
    '·  Contact GeneThrive ops with any contraindication concerns before proceeding.',
  ];
  for (const line of notes) {
    page.drawText(line, { x: 46, y, size: 9, font: fonts.regular, color: COLORS.ink });
    y -= 16;
  }

  drawFooter(page, fonts, `GeneThrive  ·  Pharmacist copy  ·  ${clientId}  ·  ${orderDate}`);
  return pdfDoc.save();
}

// ── PDF 3: Naturopath ─────────────────────────────────────────────────────────

async function generateNaturopathPdf(clientId, results, health, orderDate) {
  const { pdfDoc, page, fonts } = await makeDoc();

  let y = drawHeader(page, fonts,
    'CIL Review Package — Naturopath',
    `Client ID: ${clientId}  ·  ${orderDate}`,
    rgb(0.45, 0.30, 0.15)
  );

  y = drawClientIdBlock(page, fonts, y, clientId);
  y -= 10;

  y = drawSectionHeading(page, fonts, y, 'DNA Results Summary');
  y -= 4;
  const lines = wrapText(results, 85);
  for (const line of lines) {
    page.drawText(line, { x: 46, y, size: 10, font: fonts.regular, color: COLORS.ink });
    y -= 16;
    if (y < 200) break;
  }

  y -= 10;
  drawRule(page, y);
  y -= 20;

  y = drawSectionHeading(page, fonts, y, 'Client Lifestyle Profile');
  y -= 4;
  y = drawRow(page, fonts, y, 'Age',              health.age ? `${health.age} years` : '—');
  y = drawRow(page, fonts, y, 'Gender',           health.gender);
  y = drawRow(page, fonts, y, 'Fasting',          health.fasting === 'Yes' ? `Yes — ${health.fasting_detail || 'protocol not specified'}` : 'No');
  y = drawRow(page, fonts, y, 'Conditions',       health.conditions === 'Yes' ? health.conditions_detail : 'None');
  y = drawRow(page, fonts, y, 'Medications',      health.medications === 'Yes' ? health.medications_detail : 'None');
  y = drawRow(page, fonts, y, 'Allergies',        health.allergies === 'Yes' ? health.allergies_detail : 'None');
  y = drawRow(page, fonts, y, 'Pregnant/BF',      health.pregnant_breastfeeding || '—');

  y -= 10;
  drawRule(page, y);
  y -= 20;

  y = drawSectionHeading(page, fonts, y, 'CIL Consultation Notes');
  y -= 4;

  const notes = [
    '·  Review DNA results and lifestyle profile above.',
    '·  Complete CIL (Comprehensive Initial Lifestyle) consultation with client.',
    '·  Payment of $65.00 released to you upon CIL completion confirmation.',
    '·  Notify GeneThrive ops once consultation is complete.',
    '·  Forward any clinical recommendations to GeneThrive for formula adjustment.',
  ];
  for (const line of notes) {
    page.drawText(line, { x: 46, y, size: 9, font: fonts.regular, color: COLORS.ink });
    y -= 16;
  }

  drawFooter(page, fonts, `GeneThrive  ·  Naturopath copy  ·  ${clientId}  ·  ${orderDate}`);
  return pdfDoc.save();
}

// ── Utility: simple word wrapper ──────────────────────────────────────────────

function wrapText(text, maxChars) {
  if (!text) return ['—'];
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    if ((current + ' ' + word).trim().length > maxChars) {
      if (current) lines.push(current.trim());
      current = word;
    } else {
      current = (current + ' ' + word).trim();
    }
  }
  if (current) lines.push(current.trim());
  return lines;
}

// ── Email sender ──────────────────────────────────────────────────────────────

function createTransporter() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587', 10),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

function partnerEmailHtml(partnerName, clientId, role, actionItems, orderDate) {
  return `
    <div style="font-family:sans-serif;max-width:520px;color:#1c1c1a">
      <div style="background:#4a6741;padding:20px 24px;border-radius:8px 8px 0 0">
        <span style="color:#fff;font-size:18px;font-weight:600;letter-spacing:2px">GENETHRIVE</span>
        <span style="color:rgba(255,255,255,0.6);font-size:13px;margin-left:12px">${role}</span>
      </div>
      <div style="border:1px solid #d6cfc3;border-top:none;padding:24px;border-radius:0 0 8px 8px">
        <p style="margin:0 0 16px;font-size:15px">DNA results are ready for <strong>${clientId}</strong>.</p>
        <div style="background:#f7f4ee;border-radius:6px;padding:14px;margin-bottom:20px">
          <div style="font-size:10px;color:#4a6741;font-weight:600;letter-spacing:1px;margin-bottom:4px">CLIENT ID</div>
          <div style="font-size:20px;font-weight:700">${clientId}</div>
          <div style="font-size:12px;color:#7a7a74;margin-top:2px">${orderDate}</div>
        </div>
        <p style="font-size:13px;font-weight:600;margin:0 0 8px">Action required:</p>
        <ul style="font-size:13px;color:#4a4a46;line-height:1.8;margin:0 0 20px;padding-left:18px">
          ${actionItems.map(a => `<li>${a}</li>`).join('')}
        </ul>
        <p style="font-size:13px;color:#7a7a74;margin:0">Please find the full brief in the attached PDF.</p>
      </div>
    </div>
  `;
}

async function sendPartnerEmails(transporter, clientId, orderDate, nutripathPdf, pharmacistPdf, naturopathPdf) {
  await Promise.all([

    // Nutripath
    transporter.sendMail({
      from:    process.env.EMAIL_FROM,
      to:      process.env.EMAIL_NUTRIPATH,
      replyTo: process.env.EMAIL_REPLY_TO,
      subject: `DNA Results Ready — ${clientId} — Formula Brief Required`,
      html: partnerEmailHtml('Nutripath', clientId, 'Formula Brief', [
        'Review DNA results in the attached PDF',
        'Prepare personalised vitamin formula brief',
        'Forward compounding instructions to the pharmacist',
      ], orderDate),
      attachments: [{
        filename:    `GeneThrive-Nutripath-${clientId}.pdf`,
        content:     Buffer.from(nutripathPdf),
        contentType: 'application/pdf',
      }],
    }),

    // Pharmacist
    transporter.sendMail({
      from:    process.env.EMAIL_FROM,
      to:      process.env.EMAIL_PHARMACIST,
      replyTo: process.env.EMAIL_REPLY_TO,
      subject: `Compounding Instructions Ready — ${clientId}`,
      html: partnerEmailHtml('Pharmacist', clientId, 'Compounding', [
        'Await formula brief from Nutripath',
        'Review client contraindications in attached PDF',
        'Compound formula once brief is received',
        '$140.00 released on client pickup confirmation',
      ], orderDate),
      attachments: [{
        filename:    `GeneThrive-Pharmacist-${clientId}.pdf`,
        content:     Buffer.from(pharmacistPdf),
        contentType: 'application/pdf',
      }],
    }),

    // Naturopath
    transporter.sendMail({
      from:    process.env.EMAIL_FROM,
      to:      process.env.EMAIL_NATUROPATH,
      replyTo: process.env.EMAIL_REPLY_TO,
      subject: `CIL Review Package — ${clientId}`,
      html: partnerEmailHtml('Naturopath', clientId, 'CIL Consultation', [
        'Review DNA results and lifestyle profile in attached PDF',
        'Schedule and complete CIL consultation with client',
        '$65.00 released on CIL completion confirmation',
        'Forward clinical recommendations to GeneThrive',
      ], orderDate),
      attachments: [{
        filename:    `GeneThrive-Naturopath-${clientId}.pdf`,
        content:     Buffer.from(naturopathPdf),
        contentType: 'application/pdf',
      }],
    }),

  ]);
}

async function sendClientNotification(transporter, order, clientId) {
  const firstName = order.shipping_address?.first_name || 'there';
  await transporter.sendMail({
    from:    process.env.EMAIL_FROM,
    to:      order.email,
    replyTo: process.env.EMAIL_REPLY_TO,
    subject: `Your DNA results are in — ${clientId}`,
    html: `
      <div style="font-family:sans-serif;max-width:520px;color:#1c1c1a">
        <div style="background:#4a6741;padding:20px 24px;border-radius:8px 8px 0 0">
          <span style="color:#fff;font-size:18px;font-weight:600;letter-spacing:2px">GENETHRIVE</span>
        </div>
        <div style="border:1px solid #d6cfc3;border-top:none;padding:28px;border-radius:0 0 8px 8px">
          <h2 style="margin:0 0 16px;font-size:20px;font-weight:600">Great news, ${firstName}!</h2>
          <p style="margin:0 0 16px;font-size:14px;color:#4a4a46;line-height:1.6">
            Your DNA results have been received and your personalised formula is now being prepared by our naturopath and pharmacist.
          </p>
          <div style="background:#e8eee7;border-radius:8px;padding:16px;margin-bottom:20px">
            <div style="font-size:10px;color:#4a6741;font-weight:600;letter-spacing:1px;margin-bottom:4px">YOUR REFERENCE</div>
            <div style="font-size:18px;font-weight:700">${clientId}</div>
          </div>
          <p style="font-size:13px;font-weight:600;margin:0 0 10px">What happens next:</p>
          <ol style="font-size:13px;color:#4a4a46;line-height:1.8;margin:0 0 24px;padding-left:20px">
            <li>Our naturopath reviews your DNA results and completes your CIL consultation</li>
            <li>Our pharmacist compounds your personalised vitamin formula</li>
            <li>Your formula is dispatched — we'll be in touch with tracking details</li>
          </ol>
          <p style="font-size:13px;color:#7a7a74;margin:0">
            Questions? Contact us at
            <a href="mailto:${process.env.EMAIL_REPLY_TO}" style="color:#4a6741">${process.env.EMAIL_REPLY_TO}</a>
          </p>
        </div>
      </div>
    `,
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────

exports.handler = async function (event) {

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  // 1. Verify the lab's secret key
  const incomingSecret = event.headers['x-genethrive-secret'];
  if (!incomingSecret || incomingSecret !== process.env.LAB_WEBHOOK_SECRET) {
    console.warn('GeneThrive: dispatch-results — invalid or missing secret');
    return { statusCode: 401, body: 'Unauthorized' };
  }

  // 2. Parse the lab's payload
  let clientId, results, reportUrl;
  try {
    const body = JSON.parse(event.body);
    clientId  = body.clientId;
    results   = body.results;
    reportUrl = body.reportUrl || null;
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  if (!clientId || !results) {
    return { statusCode: 400, body: 'Missing clientId or results' };
  }

  console.log(`GeneThrive: Results received for ${clientId}`);

  const { SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_TOKEN } = process.env;
  const shopifyHeaders = {
    'Content-Type':           'application/json',
    'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
  };

  // 3. Find the Shopify order by Client ID tag
  // process-order.js tagged every order with "client-id:GT-XXXX-XXXX"
  let order;
  try {
    const res = await fetch(
      `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/orders.json` +
      `?tag=client-id:${encodeURIComponent(clientId)}&status=any&limit=1`,
      { headers: shopifyHeaders }
    );
    const data = await res.json();
    order = data.orders?.[0];
  } catch (err) {
    console.error('GeneThrive: Failed to fetch order —', err.message);
    return { statusCode: 500, body: 'Failed to fetch order' };
  }

  if (!order) {
    console.error(`GeneThrive: No order found for client ID ${clientId}`);
    return { statusCode: 404, body: `No order found for client ID ${clientId}` };
  }

  console.log(`GeneThrive: Found order #${order.order_number} for ${clientId}`);

  // 4. Extract health data from order attributes
  const health = {};
  for (const attr of (order.note_attributes || [])) {
    if (attr.name.startsWith('health_')) {
      health[attr.name.replace('health_', '')] = attr.value;
    }
  }

  const orderDate = new Date().toLocaleDateString('en-AU', {
    day: '2-digit', month: 'long', year: 'numeric',
  });

  // 5. Generate all 3 partner PDFs in parallel
  let nutripathPdf, pharmacistPdf, naturopathPdf;
  try {
    [nutripathPdf, pharmacistPdf, naturopathPdf] = await Promise.all([
      generateNutripathPdf(clientId, results, health, orderDate, reportUrl),
      generatePharmacistPdf(clientId, results, health, orderDate),
      generateNaturopathPdf(clientId, results, health, orderDate),
    ]);
    console.log(`GeneThrive: 3 partner PDFs generated for ${clientId}`);
  } catch (err) {
    console.error('GeneThrive: PDF generation failed —', err.message);
    return { statusCode: 500, body: 'PDF generation failed' };
  }

  // 6. Send partner emails + client notification
  const transporter = createTransporter();
  try {
    await Promise.all([
      sendPartnerEmails(transporter, clientId, orderDate, nutripathPdf, pharmacistPdf, naturopathPdf),
      sendClientNotification(transporter, order, clientId),
    ]);
    console.log(`GeneThrive: All partner emails sent for ${clientId}`);
  } catch (err) {
    console.error('GeneThrive: Email sending failed —', err.message);
  }

  // 7. Tag the Shopify order as results-dispatched
  try {
    const existingTags = order.tags ? order.tags.split(', ') : [];
    existingTags.push('results-dispatched');
    await fetch(
      `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/orders/${order.id}.json`,
      {
        method: 'PUT',
        headers: shopifyHeaders,
        body: JSON.stringify({ order: { id: order.id, tags: existingTags.join(', ') } }),
      }
    );
    console.log(`GeneThrive: Order #${order.order_number} tagged results-dispatched`);
  } catch (err) {
    console.warn('GeneThrive: Order tagging failed —', err.message);
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      success:  true,
      clientId,
      order:    order.order_number,
      message:  'Results dispatched to Nutripath, Pharmacist, and Naturopath',
    }),
  };
};