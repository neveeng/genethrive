/**
 * GeneThrive — scheduled function (Netlify Scheduled Functions / a cron
 * trigger calling this URL periodically, e.g. hourly) that flips any
 * sla_clocks row past its due_at and not yet acknowledged to 'amber' (past
 * due, under 24h late) or 'red' (over 24h late) — this is what makes the
 * ops Chain Oversight dashboard's clock colours actually mean something, for
 * every clock kind already defined in the locked schema (including
 * 'handoff_tsi_48h', the one send-compounding-order-to-pharmacy.js starts).
 *
 * Does not send any notification itself — it only updates state; a
 * dashboard or a separate notify-on-red function can watch for state='red'.
 * Kept deliberately simple and side-effect-free beyond that one column, so
 * it's safe to run as often as needed without risk of double-sending
 * anything.
 *
 * ENVIRONMENT VARIABLES NEEDED: SUPABASE_URL, SUPABASE_SERVICE_KEY.
 */
import { selectAll, updateByColumn } from './_lib/supabase-rest';

export async function handler() {
  try {
    const clocks = await selectAll('sla_clocks');
    const now = Date.now();
    let updated = 0;
    for (const clock of clocks) {
      if (clock.acknowledged_at || !clock.due_at) continue;
      const dueAt = new Date(clock.due_at).getTime();
      const hoursLate = (now - dueAt) / 3600000;
      let nextState = clock.state;
      if (hoursLate > 24) nextState = 'red';
      else if (hoursLate > 0) nextState = 'amber';
      else nextState = 'green';
      if (nextState !== clock.state) {
        await updateByColumn('sla_clocks', 'id', clock.id, { state: nextState });
        updated++;
      }
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true, checked: clocks.length, updated }) };
  } catch (err) {
    console.error('check-overdue-sla-clocks: failed:', err.message);
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'Storage failure' }) };
  }
}
