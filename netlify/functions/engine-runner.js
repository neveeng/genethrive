/**
 * GeneThrive — engine-runner
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs the GeneThrive Engine HTML file inside a headless browser on the server.
 * The Engine file never leaves the server — the caller receives only the
 * finished protocol document as HTML.
 *
 * Usage:
 *   const { runEngine } = require('./engine-runner');
 *   const result = await runEngine({
 *     dnaPath:    '/tmp/dna.pdf',          // optional
 *     intakePath: '/tmp/intake.json',      // genethrive.intake.v1
 *     contact:    { mobile, email, addrStreet, addrSuburb, addrState, addrPostcode },
 *     clientCode: 'GT-2026-0001',
 *     pin:        process.env.PRACTITIONER_PIN,
 *     docType:    'practitioner',          // 'practitioner' | 'compounding' | 'client'
 *   });
 *   // result.ok    — true if a document was produced
 *   // result.html  — the rendered protocol document
 *   // result.errors — any validation or page errors
 *
 * Note: clicking Generate alone does not produce a document — it stores the
 * result in window._lastResult and reveals three buttons. The actual document
 * is rendered only after one of those buttons is clicked. This runner clicks
 * the button matching docType and reads the result from the iframe.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const chromium           = require('@sparticuz/chromium');
const { chromium: pw }   = require('playwright-core');
const path               = require('path');

const DEFAULT_ENGINE_PATH = path.join(__dirname, 'engine-file', 'GeneThrive_Engine.html');

async function runEngine({
  dnaPath,
  intakePath,
  contact = {},
  clientCode,
  pin,
  docType = 'practitioner',
  enginePath = DEFAULT_ENGINE_PATH,
  evidenceDate = new Date().toISOString().slice(0, 10),
  timeoutMs = 30000,
}) {
  if (!pin) throw new Error('runEngine: pin is required (practitioner PIN, e.g. Barbara\'s 8100)');
  if (!intakePath) throw new Error('runEngine: intakePath is required');

  const DOC_BUTTON_SELECTOR = {
    practitioner: '.btn-doc-nat',
    compounding: '.btn-doc-phar',
    client: '.btn-doc-cli',
  }[docType];
  if (!DOC_BUTTON_SELECTOR) {
    throw new Error("runEngine: docType must be one of 'practitioner', 'compounding', 'client'");
  }

  const browser = await pw.launch({
    args:           chromium.args,
    executablePath: await chromium.executablePath(),
    headless:       chromium.headless,
  });
  const errors = [];
  let html = null;

  try {
    const page = await browser.newPage();
    page.on('pageerror', (err) => errors.push('page error: ' + err.message));

    await page.goto('file://' + enginePath, { waitUntil: 'load', timeout: timeoutMs });

    // 1. Practitioner login
    await page.fill('#login-pin', pin);
    await page.click('button:has-text("Login")');
    await page.waitForTimeout(400);
    const loginFailed = await page.isVisible('#login-error').catch(() => false);
    if (loginFailed) {
      return { ok: false, html: null, errors: ['Login rejected — check the PIN.'] };
    }

    // 2. Upload DNA extract (optional — some document types don't need it)
    if (dnaPath) {
      await page.setInputFiles('#file-ingest-dna', dnaPath);
      await page.waitForTimeout(1200);
    }

    // 3. Upload intake JSON
    await page.setInputFiles('#file-ingest-intake', intakePath);
    await page.waitForTimeout(1200);

    // 4. Resolve an identity near-match hold if the Engine raises one
    //    (e.g. a one-letter name typo between the DNA lab report and the intake form)
    const agreeBtn = await page.$('button:has-text("Agree")');
    if (agreeBtn) {
      await agreeBtn.click();
      await page.waitForTimeout(400);
    }

    // 5. Fill any contact/admin fields the intake file itself doesn't carry.
    //    (As of Engine v3.5.148 and Form v2.2, contact details flow through the
    //    intake file automatically — these are a safety-net fallback only.)
    if (contact.mobile) await page.fill('#mobile', contact.mobile).catch(() => {});
    if (contact.email) await page.fill('#email', contact.email).catch(() => {});
    if (contact.addrStreet) await page.fill('#addr-street', contact.addrStreet).catch(() => {});
    if (contact.addrSuburb) await page.fill('#addr-suburb', contact.addrSuburb).catch(() => {});
    if (contact.addrPostcode) await page.fill('#addr-postcode', contact.addrPostcode).catch(() => {});
    if (contact.addrState) {
      await page.evaluate((stateVal) => {
        const el = document.getElementById('addr-state');
        if (!el) return;
        for (const opt of el.options) {
          if (opt.value && opt.value.toUpperCase() === String(stateVal).trim().toUpperCase()) {
            el.value = opt.value;
            el.dispatchEvent(new Event('change'));
            break;
          }
        }
      }, contact.addrState).catch(() => {});
    }
    if (clientCode) await page.fill('#client-code', clientCode).catch(() => {});
    await page.fill('#evidence-date', evidenceDate).catch(() => {});

    // 6. Click Generate
    const genBtn = await page.$('#generate-btn');
    if (!genBtn) {
      return { ok: false, html: null, errors: ['Generate button not found — Engine file may be the wrong version.'] };
    }
    await genBtn.scrollIntoViewIfNeeded();
    await genBtn.click({ timeout: 10000 }).catch(() => genBtn.click({ force: true }));
    await page.waitForTimeout(3000);

    // 7. Check for validation errors the Engine itself raised (missing required fields etc.)
    const visibleErrors = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.error-msg.visible')).map((e) => e.id + ': ' + e.textContent)
    );
    if (visibleErrors.length) {
      errors.push(...visibleErrors);
      return { ok: false, html: null, errors };
    }

    const gotResult = await page.evaluate(() => !!window._lastResult);
    if (!gotResult) {
      return { ok: false, html: null, errors: ['Generate did not produce a result — check required fields.'] };
    }

    // 8. Generate only computes the result — the actual document is rendered by
    //    one of the three "open copy" buttons (confirmed by direct testing, see
    //    the note above). Click the one matching the requested docType.
    const docBtn = await page.$(DOC_BUTTON_SELECTOR);
    if (!docBtn) {
      return { ok: false, html: null, errors: [`Document button not found for docType "${docType}".`] };
    }
    await docBtn.click();
    await page.waitForTimeout(1500);

    // 9. Read back the generated document
    html = await page.evaluate(() => {
      const ifr = document.getElementById('doc-iframe');
      return ifr ? ifr.srcdoc : null;
    });

    return { ok: !!html && errors.length === 0, html, errors };
  } finally {
    await browser.close();
  }
}

module.exports = { runEngine, DEFAULT_ENGINE_PATH };
