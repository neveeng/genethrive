// sla-logic.js
// Shared SLA computation — this is the SAME logic as the dashboard's
// statusFor()/workingDaysElapsed() in GeneThrive_ChainOversightDashboard.
// Keeping it in one small file means the dashboard and the alert
// functions can never quietly drift into disagreeing about what counts
// as "breached".

const STAGES = [
  { key: 'signup',         label: 'Signup & payment',     slaHours: null },
  { key: 'health_profile', label: 'Health Profile',       slaHours: null },
  { key: 'kit_dispatch',   label: 'Kit dispatch',         slaHours: 48 },
  { key: 'swab_return',    label: 'Swab return',          slaWorkingDays: 7 },
  { key: 'sequencing',     label: 'NutriPath sequencing', slaHours: null },
  { key: 'engine_run',     label: 'Engine run',           slaHours: 48 },
  { key: 'barbara_review', label: 'Barbara review',       slaHours: 4 },
  { key: 'compounding',    label: 'Compounding (TSI)',    slaHours: 72 },
  { key: 'shipped',        label: 'Shipped',              slaHours: null },
];
const WARN_FRACTION = 0.85;

function workingDaysElapsed(startISO, nowDate) {
  const start = new Date(startISO);
  const now = nowDate || new Date();
  const startDay = new Date(start); startDay.setHours(0, 0, 0, 0);
  let days = 0;
  const d = new Date(startDay);
  while (d < now) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) days += 1;
    d.setDate(d.getDate() + 1);
  }
  const msPerDay = 24 * 3600 * 1000;
  const fractionUsedOnStartDay = (start - startDay) / msPerDay;
  const startDow = start.getDay();
  if (startDow !== 0 && startDow !== 6) days -= fractionUsedOnStartDay;
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const fractionUsedToday = (now - today) / msPerDay;
  const todayDow = now.getDay();
  if (todayDow !== 0 && todayDow !== 6 && today > startDay) days -= (1 - fractionUsedToday);
  return Math.max(0, days);
}

function hoursElapsed(startISO, nowDate) {
  const now = nowDate || new Date();
  return (now.getTime() - new Date(startISO).getTime()) / 3600000;
}

/**
 * @param {{stage: string, stageEnteredAt: string}} client
 * @returns {{stageDef: object|null, status: 'good'|'warn'|'crit', fraction: number}}
 */
function statusFor(client, nowDate) {
  const stageDef = STAGES.find((s) => s.key === client.stage) || null;
  if (!stageDef) return { stageDef: null, status: 'good', fraction: 0 };

  let elapsed, sla;
  if (stageDef.slaWorkingDays) {
    elapsed = workingDaysElapsed(client.stageEnteredAt, nowDate);
    sla = stageDef.slaWorkingDays;
  } else if (stageDef.slaHours) {
    elapsed = hoursElapsed(client.stageEnteredAt, nowDate);
    sla = stageDef.slaHours;
  } else {
    return { stageDef, status: 'good', fraction: 0 };
  }

  const fraction = elapsed / sla;
  let status = 'good';
  if (fraction >= 1) status = 'crit';
  else if (fraction >= WARN_FRACTION) status = 'warn';
  return { stageDef, status, fraction };
}

module.exports = { STAGES, workingDaysElapsed, hoursElapsed, statusFor, WARN_FRACTION };