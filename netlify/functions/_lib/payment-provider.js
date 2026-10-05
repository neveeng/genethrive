/**
 * GeneThrive — pluggable payout abstraction for paying TSI (the compounding
 * pharmacy) via Stripe Connect.
 *
 * Uses the same Stripe Connect transfer pattern as finalise-order.js
 * (NutriPath transfer) and barbara-engine.js (Barbara's $65 payout).
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY       sk_live_... (or sk_test_... in test mode)
 *   STRIPE_ACCOUNT_TSI      acct_... (TSI's Stripe Connect account ID)
 *
 * If STRIPE_ACCOUNT_TSI is not set, the payout is SIMULATED (logged, returns
 * ok:true, simulated:true) so the pipeline can run end-to-end in dev/test
 * without a real payout firing. Set both vars in production to activate.
 *
 * The invoice amount (invoiceCents) is stated by TSI when they call
 * pharmacy-acknowledge.js — it is not a fixed price because compounding
 * scripts vary per client protocol.
 */

import Stripe from 'stripe';

async function payPayee({ payee, amountCents, orderRef, reference }) {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const tsiAccount = process.env.STRIPE_ACCOUNT_TSI;

  if (!secretKey || !tsiAccount) {
    console.log(
      `[SIMULATED PAYOUT] ${payee} — $${(amountCents / 100).toFixed(2)} ` +
      `for order ${orderRef} (${reference}) — set STRIPE_SECRET_KEY + STRIPE_ACCOUNT_TSI to activate`
    );
    return {
      ok: true,
      simulated: true,
      reason: !secretKey
        ? 'STRIPE_SECRET_KEY not configured'
        : 'STRIPE_ACCOUNT_TSI not configured',
    };
  }

  try {
    const stripe = Stripe(secretKey);
    const transfer = await stripe.transfers.create({
      amount: amountCents,
      currency: 'aud',
      destination: tsiAccount,
      description: `GeneThrive TSI payout — order ${orderRef} (${reference})`,
      metadata: { orderRef, payee, reference },
    });
    return { ok: true, simulated: false, providerId: transfer.id };
  } catch (err) {
    console.error('GeneThrive: Stripe TSI payout failed —', err.message);
    return { ok: false, simulated: false, reason: 'Stripe error: ' + err.message };
  }
}

export default { payPayee };