/**
 * GeneThrive — generate-protocol
 * ─────────────────────────────────────────────────────────────────────────────
 * Netlify Function: netlify/functions/generate-protocol.js
 *
 * Receives a request from the naturopath portal, writes the uploaded files to
 * a temp folder, runs the Engine via engine-runner, and returns the finished
 * protocol document as HTML. The Engine file never leaves the server.
 *
 * Request body (JSON):
 *   {
 *     "dnaBase64":  "...",      // optional — base64 of the DNA extract PDF
 *     "intakeJson": { ... },    // genethrive.intake.v1 object
 *     "contact":    { "mobile", "email", "addrStreet", "addrSuburb", "addrState", "addrPostcode" },
 *     "clientCode": "GT-2026-0001",
 *     "docType":    "practitioner"   // optional — "practitioner" (default) | "compounding" | "client"
 *   }
 *
 * Response body (JSON):
 *   { "ok": true,  "html": "<...generated document...>" }
 *   { "ok": false, "errors": ["..."] }
 *
 * ENVIRONMENT VARIABLES:
 *   PRACTITIONER_PIN   — engine auto-login PIN (never sent from the browser)
 *
 * DEPLOYMENT:
 *   - Engine file must sit at netlify/functions/engine-file/GeneThrive_Engine_*.html
 *   - Must NOT be placed in /public or /dist — it must not be reachable by URL
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { runEngine } = require('./engine-runner');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ ok: false, errors: ['POST only'] }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, errors: ['Invalid JSON body'] }) };
  }

  const { dnaBase64, intakeJson, contact, clientCode, docType } = body;
  if (!intakeJson) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, errors: ['intakeJson is required'] }) };
  }

  // PIN comes from env var server-side — never accepted from the browser request.
  const pin = process.env.PRACTITIONER_PIN;
  if (!pin) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, errors: ['PRACTITIONER_PIN env var not set'] }) };
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genethrive-'));
  const intakePath = path.join(workDir, 'intake.json');
  fs.writeFileSync(intakePath, JSON.stringify(intakeJson));

  let dnaPath = null;
  if (dnaBase64) {
    dnaPath = path.join(workDir, 'dna.pdf');
    fs.writeFileSync(dnaPath, Buffer.from(dnaBase64, 'base64'));
  }

  try {
    const result = await runEngine({ dnaPath, intakePath, contact, clientCode, pin, docType: docType || 'practitioner' });
    return {
      statusCode: result.ok ? 200 : 422,
      body: JSON.stringify(result),
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, errors: [e.message] }) };
  } finally {
    // Clean up the uploaded files immediately — never leave client DNA/health
    // data sitting in a temp folder on the server after the request finishes.
    fs.rmSync(workDir, { recursive: true, force: true });
  }
};
