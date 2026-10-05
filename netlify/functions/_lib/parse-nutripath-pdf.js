/**
 * GeneThrive — attempts to turn a NutriPath lab report PDF's raw text into a
 * genethrive.dna.v1 extract (the same {schema, variants:[{gene, zygosity, ...}]}
 * shape the Engine's importDnaExtract() expects).
 *
 * HONEST STATUS, READ THIS FIRST: this has never been built against, or
 * tested against, a single real NutriPath report. Every sample PDF present
 * anywhere in this project (checked directly — see CHANGELOG note below) is
 * a GeneThrive-authored document (Health Profile, Compounding Order costing,
 * Practitioner Copy sample, sign-off review) — none of them is an actual raw
 * NutriPath lab report. Writing a confident field-by-field parser without
 * ever having seen the real layout would mean guessing at gene/zygosity
 * column positions for clinical data that flows straight into dosing — the
 * exact kind of fabrication this project's whole design (see
 * generate-real-client-report.js's header) exists to rule out.
 *
 * So this module deliberately does NOT claim to extract variants
 * automatically yet. What it does today:
 *   1. Extracts the PDF's raw text (via pdf-parse) reliably — that part is
 *      generic and needs no calibration.
 *   2. Looks for an order reference (GT-2026-NNNN pattern) anywhere in the
 *      text or filename, so the report can at least be filed against the
 *      right client automatically.
 *   3. Returns { confident: false, dna: null, rawText, orderRef, reason }
 *      unconditionally for the variant extraction itself — see
 *      nutripath-inbound-email.js, which routes every report to a
 *      pending_lab_reports row for Barbara/ops to map by hand rather than
 *      ever auto-writing unverified variant data into dna_results.
 *
 * TO FINISH THIS PROPERLY: send me (or have Neveen send me) one real,
 * de-identified NutriPath report PDF. From an actual sample I can write a
 * real column/row parser and a real test against it — the same way every
 * other piece of this project was built from real data, never guessed. Until
 * then, this manual-review path is the correct and safe behaviour, not a
 * placeholder to feel bad about — it's the same evidence-first standard the
 * Engine itself enforces on citations, applied here to lab data ingestion.
 */
const pdfParse = require('pdf-parse');

const ORDER_REF_RE = /\bGT-\d{4}-\d{3,6}\b/;

async function parseNutriPathPdf(pdfBuffer, filenameHint) {
  const parsed = await pdfParse(pdfBuffer);
  const rawText = parsed.text || '';

  const fromFilename = filenameHint && ORDER_REF_RE.exec(filenameHint);
  const fromText = ORDER_REF_RE.exec(rawText);
  const orderRef = (fromFilename && fromFilename[0]) || (fromText && fromText[0]) || null;

  return {
    confident: false,
    dna: null,
    rawText,
    orderRef,
    reason:
      'No calibrated NutriPath layout yet — see this file\'s header comment. ' +
      'Routed to manual review rather than guessing at clinical variant data.',
  };
}

module.exports = { parseNutriPathPdf, ORDER_REF_RE };
