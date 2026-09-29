/**
 * GeneThrive — toEngineIntakeV1(wizardRecord)
 * =============================================================================
 * Converts the Client Health Profile intake wizard's `buildRecord()` output
 * (see GeneThrive_ClientHealthProfile_Form_Wizard_25Sep2026.html) into the
 * EXACT shape the Engine's own `importIntakeJson()` validator requires — the
 * "genethrive.intake.v1" schema (see GeneThrive_Engine_v3.5.147_PATCHED_*
 * .html, section "4.2 importIntakeJson", read field-by-field to build this).
 *
 * Root cause of the bug this fixes: the wizard's record has NO `schema`
 * field at all, and importIntakeJson() does exactly one hard check —
 *   if (!json || json.schema !== "genethrive.intake.v1") throw ...
 * — everything else in importIntakeJson() is soft (a missing/mismatched
 * field is recorded in report.unanswered/report.notes, never thrown). So the
 * SINGLE thing that made every wizard submission fail the import was the
 * missing schema tag. Beyond that single hard gate, the two shapes disagree
 * field-by-field in ways that would otherwise silently drop real clinical
 * intake data even though the import wouldn't throw — full list below.
 *
 * ---------------------------------------------------------------------------
 * FIELD-BY-FIELD MAPPING AND EVERY MISMATCH FOUND (verified against the
 * importIntakeJson() source, not assumed):
 *
 *  wizard field                          -> engine (genethrive.intake.v1)      notes
 *  ------------------------------------------------------------------------------------------------
 *  (nothing — absent entirely)           -> schema                            MUST add "genethrive.intake.v1" — this is the actual bug.
 *  identity.firstName + .lastName        -> name (single "First Last" string) engine splits on whitespace; wizard keeps them separate.
 *  demographics.dob                      -> dob                               same ISO string, direct pass-through.
 *  demographics.sex ("male"/"female")    -> sex                               same values, direct pass-through.
 *  demographics.weightKg                 -> weight_kg                         renamed only.
 *  intake.pregnancy.status ("yes"/"no")  -> pregnancy.answer                  renamed/nested differently.
 *  intake.pregnancy.subState             -> pregnancy.items (array of phrases) MISMATCH: engine re-derives subState itself from free-text
 *                                                                              `items` phrases containing "pregnant"/"breastfeed"/"planning".
 *                                                                              The wizard only keeps the already-reduced subState code, so this
 *                                                                              converter maps it back to a one-item phrase array that reproduces
 *                                                                              the exact same substring match engine-side.
 *  intake.shellfishAllergy (boolean)     -> shellfish.answer ("yes"/"no")     MISMATCH: boolean vs. yes/no string, and un-nested vs. nested.
 *  intake.bariatricIbd (boolean)         -> gastric_surgery.answer            MISMATCH: same as above, also renamed.
 *  intake.medications (string[])         -> meds.items (string[])            direct pass-through of the array itself.
 *  (medications.length > 0, inferred)    -> meds.answer ("yes"/"no")         MISMATCH: wizard nowhere preserves the explicit yes/no answer to
 *                                                                              "are you taking any medications" in its OUTPUT record (only the
 *                                                                              resulting list) — this converter infers "yes" iff the list is
 *                                                                              non-empty. Correct for every real case (the wizard only populates
 *                                                                              the list when the answer was yes) but is an inference, not a
 *                                                                              stored fact — flagged per the task's instruction to call this out.
 *  additional.medicationsDosingNotes     -> meds.dosing                       renamed/relocated only.
 *  intake.conditions (string[])          -> cond.items / cond.answer          same inferred-answer pattern as meds above.
 *  additional.bloodThinners (string[])   -> blood.items / blood.answer        NEW top-level field on the engine side; wizard already tracks this
 *                                                                              list separately (under additional), just needed lifting + an
 *                                                                              inferred answer, same pattern as meds/cond above.
 *  intake.diet (single code: "omnivore"  -> diet (array of PHRASES)          MISMATCH (real bug if left unconverted): importIntakeJson() does
 *   | "vegetarian" | "vegan")                                                 NOT match on the codes "omnivore"/"vegetarian" — it string-searches
 *                                                                              the joined diet array for the literal phrases "meat and fish" /
 *                                                                              "no meat or fish" / "vegan". Sending the code "vegetarian" as-is
 *                                                                              would match NONE of those branches and diet would come back
 *                                                                              silently unanswered. Mapped: omnivore->["meat and fish"],
 *                                                                              vegetarian->["no meat or fish"], vegan->["vegan"].
 *  (no gluten-free question anywhere      -> diet "gluten free" modifier /    GAP: the wizard has no gluten-free intake question at all (only a
 *   in the wizard)                          #gluten-free select                "coeliac disease" condition checkbox, which already flows through
 *                                                                              cond.items as "coeliac"). Left unanswered rather than guessed.
 *  intake.oilyFish (freq code)           -> oily_fish_freq                    SAME literal codes ("3plus"/"1-2"/"rarely") — verified against the
 *                                                                              engine's #oilyfish <select> option values; direct pass-through.
 *  additional.sleep.liesAwake            -> sleep.lies_awake                  renamed (camelCase -> snake_case key), object shape unchanged
 *  additional.sleep.wakesNight           -> sleep.wakes_night                 ({answer, freq}); freq text values ("3 or more nights a week" /
 *  additional.sleep.wakesEarly           -> sleep.wakes_early                 "Less often than that") verified to match the engine's per-sleep
 *  additional.sleep.restlessLegs         -> sleep.restless_legs               -freq <select> options exactly — direct pass-through.
 *  additional.sleep.durationOfIssues     -> sleep.duration                    renamed; wizard's duration button text verified to match the
 *                                                                              engine's #sleep-duration <select> options exactly.
 *  intake.activeSymptoms includes        -> anxiety.answer / headaches.answer / MISMATCH: the wizard's OUTPUT record never keeps an explicit
 *   "anxiety"/"headache"/"nausea"/          nausea.answer / palpitations.answer  yes/no per symptom — only the final coded activeSymptoms array
 *   "palpitations"                                                             (which is how the engine's OWN symptom checkboxes are ultimately
 *                                                                              set anyway). This converter infers each answer from array
 *                                                                              membership, which reproduces the same downstream checkbox state,
 *                                                                              but headaches.freq (the engine also asks "how often") has NO
 *                                                                              source anywhere in the wizard — GAP, left unanswered.
 *  additional.reportedSymptoms           -> cognition.answer / energy.answer  MISMATCH: boolean vs. yes/no string, renamed/relocated. cognition
 *   .memoryOrFocusIssues / .lowEnergyOrFatigue                                 .freq ("how often") has no source in the wizard — GAP, unanswered.
 *  additional.lifestyle.smokes           -> smokes.answer                     renamed/relocated only (already "yes"/"no"/null).
 *  additional.otherNotes                 -> other.answer / other.text         MISMATCH: wizard only keeps the free-text note (or null); the
 *                                                                              explicit "anything else?" yes/no is inferred from whether the
 *                                                                              note is non-empty.
 *  additional.lifestyle.exerciseFreq     -> exercise_freq                     verified against the engine's #exercise-freq <select> — wizard's
 *                                                                              grid button text ("Rarely or never", "1–2 times a week", etc.,
 *                                                                              including the en-dash) matches the option values EXACTLY;
 *                                                                              direct pass-through.
 *  additional.lifestyle.alcoholPerWeek   -> alcohol_per_week                  same verification/pass-through as exercise_freq.
 *  restless-legs-freq / cognition-freq /   (no source in the wizard)          GAP (see above): three "how often" engine fields the wizard never
 *   headaches-freq                                                            asks. Recorded here as unanswered, never guessed.
 *
 * SEPARATE, ENGINE-SIDE LIMITATION (not fixed by this converter, flagged for
 * visibility): fields such as additional.onStatin, .hormoneTherapy,
 * .onMentalHealthOrSeizureMedication, .iodineOrKelpUse, .onDiabetesMedication
 * and .onRefluxMedication drive real clinical rules in buildProtocol() (statin
 * CoQ10, hormone-therapy interaction, Hashimoto+iodine caution, etc.) via
 * `fd.additional.*` — but `fd.additional` is populated ONLY by the separate
 * importClientRecord() machine-contract path, never by importIntakeJson() /
 * the practitioner form's own collectFormData(). That means even a perfectly
 * converted genethrive.intake.v1 record loaded through "Open in Engine" (the
 * importIntakeJson() path) will NOT deliver these fields to the rule engine —
 * they simply have no DOM field and no import-time write in this Engine
 * build. This converter still forwards the wizard's original `additional`
 * object unchanged (harmless — importIntakeJson() ignores unknown top-level
 * keys) so it is available the moment that wiring gap is closed engine-side,
 * but closing it is outside this converter's contract (the genethrive.intake
 * .v1 schema itself has no slot for these fields).
 * ---------------------------------------------------------------------------
 */

function ynFromBool(b) {
  return b === true ? 'yes' : 'no';
}

function dietCodeToPhrases(code) {
  // importIntakeJson() string-searches the JOINED diet array for these exact
  // phrases — the wizard's codes ("omnivore"/"vegetarian"/"vegan") must be
  // translated to them, not passed through as-is.
  if (code === 'omnivore') return ['meat and fish'];
  if (code === 'vegetarian') return ['no meat or fish'];
  if (code === 'vegan') return ['vegan'];
  return [];
}

function pregSubStateToItems(subState) {
  if (subState === 'pregnant') return ['Pregnant now'];
  if (subState === 'breastfeeding') return ['Breastfeeding'];
  if (subState === 'planning') return ['Planning pregnancy in the next 12 months'];
  return [];
}

function toEngineIntakeV1(wizardRecord) {
  const rec = wizardRecord || {};
  const identity = rec.identity || {};
  const demographics = rec.demographics || {};
  const intake = rec.intake || {};
  const additional = rec.additional || {};
  const sleepIn = additional.sleep || {};
  const lifestyle = additional.lifestyle || {};
  const reportedSymptoms = additional.reportedSymptoms || {};
  const activeSymptoms = Array.isArray(intake.activeSymptoms) ? intake.activeSymptoms : [];
  const hasSymptom = (code) => activeSymptoms.indexOf(code) !== -1;

  const medications = Array.isArray(intake.medications) ? intake.medications : [];
  const conditions = Array.isArray(intake.conditions) ? intake.conditions : [];
  const bloodThinners = Array.isArray(additional.bloodThinners) ? additional.bloodThinners : [];

  const name = [identity.firstName, identity.lastName].filter(Boolean).join(' ').trim() || null;

  const pregnancyIn = intake.pregnancy || {};
  const pregAnswer = pregnancyIn.status === 'yes' ? 'yes' : (pregnancyIn.status === 'no' ? 'no' : null);

  const mkSleepEntry = (e) => ({ answer: (e && e.answer) || null, freq: (e && e.freq) || null });

  const otherText = additional.otherNotes || null;

  return {
    schema: 'genethrive.intake.v1',

    name: name,
    dob: demographics.dob || null,
    sex: demographics.sex || null,
    weight_kg: (demographics.weightKg === undefined || demographics.weightKg === null) ? null : demographics.weightKg,

    pregnancy: {
      answer: pregAnswer,
      items: pregSubStateToItems(pregnancyIn.subState),
    },
    shellfish: { answer: ynFromBool(intake.shellfishAllergy) },
    gastric_surgery: { answer: ynFromBool(intake.bariatricIbd) },

    meds: {
      answer: medications.length > 0 ? 'yes' : 'no',
      items: medications,
      dosing: additional.medicationsDosingNotes || null,
    },
    cond: {
      answer: conditions.length > 0 ? 'yes' : 'no',
      items: conditions,
    },
    blood: {
      answer: bloodThinners.length > 0 ? 'yes' : 'no',
      items: bloodThinners,
    },

    diet: dietCodeToPhrases(intake.diet),
    oily_fish_freq: intake.oilyFish || null,

    sleep: {
      lies_awake: mkSleepEntry(sleepIn.liesAwake),
      wakes_night: mkSleepEntry(sleepIn.wakesNight),
      wakes_early: mkSleepEntry(sleepIn.wakesEarly),
      restless_legs: mkSleepEntry(sleepIn.restlessLegs),
      duration: sleepIn.durationOfIssues || null,
    },

    anxiety: { answer: hasSymptom('anxiety') ? 'yes' : 'no' },
    // headaches.freq has no source anywhere in the wizard record — left null
    // (unanswered), never guessed.
    headaches: { answer: hasSymptom('headache') ? 'yes' : 'no', freq: null },
    nausea: { answer: hasSymptom('nausea') ? 'yes' : 'no' },
    palpitations: { answer: hasSymptom('palpitations') ? 'yes' : 'no' },

    // cognition.freq ("how often") has no source in the wizard — left null.
    cognition: { answer: ynFromBool(reportedSymptoms.memoryOrFocusIssues), freq: null },
    energy: { answer: ynFromBool(reportedSymptoms.lowEnergyOrFatigue) },

    smokes: { answer: lifestyle.smokes === 'yes' ? 'yes' : (lifestyle.smokes === 'no' ? 'no' : null) },
    other: { answer: otherText ? 'yes' : 'no', text: otherText },

    exercise_freq: lifestyle.exerciseFreq || null,
    alcohol_per_week: lifestyle.alcoholPerWeek || null,

    // Passed through unchanged for anything downstream that may one day read
    // it directly (see the engine-side limitation note above), and for audit
    // visibility. importIntakeJson() ignores unknown top-level keys.
    additional: additional,
    clientId: rec.clientId || null,
    urgentFlags: rec.urgentFlags || [],
    requiresImmediateReview: !!rec.requiresImmediateReview,
    completedAt: rec.completedAt || null,
  };
}

module.exports = { toEngineIntakeV1, dietCodeToPhrases, pregSubStateToItems };
