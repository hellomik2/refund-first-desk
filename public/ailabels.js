// Who answered, in the words the page shows. A prepared case replays an answer Claude gave in an earlier
// live run ("recorded"); the page says so wherever it names the model, so a replay never reads as a live call.
// Pure string functions, so the tests can read them without a browser.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const REPLAYED = 'recorded answer replayed';
const replayed = (ai) => ai?.provider === 'recorded';
// Over a cap the desk does not call the AI (src/context.js); the answer is empty and named "not-called".
const CAPS = { DAILY_AI_CALL_CAP: 'daily AI call limit reached', AI_SPEND_CAP: 'AI spending cap reached' };
const skipped = (ai) => ai?.provider === 'not-called';
const why = (ai) => CAPS[ai.notCalled] || 'an AI limit was reached';

/** Header pill: the desk's AI, and whether the latest answer on the case on screen (deep check, else quick) was replayed. */
export function aiPillText(flags, kase) {
  if (flags.aiProvider === 'fixture') return 'AI not connected: stand-in answers';
  if (flags.aiProvider === 'recorded') return 'AI: recorded answers replayed';
  const model = flags.aiModel || flags.aiProvider;
  const latest = kase?.investigation?.ai || kase?.quick?.ai;
  if (skipped(latest)) return `AI: ${model}, not called for this case (${why(latest)})`;
  return replayed(latest) ? `AI: ${model}, ${REPLAYED}` : `AI: ${model}`;
}

/** The quick check's "who answered", inside the brackets after its line. */
export function quickAiSource(ai) {
  return ai.provider === 'fixture' ? 'stand-in answers' : `${esc(ai.model || ai.provider)}${replayed(ai) ? `, ${REPLAYED}` : ''}`;
}

/** The quick check's line on who answered. */
export function quickAiLine(q) {
  if (!q.ai) return 'Code found a mismatch first, so the AI was not asked.';
  if (skipped(q.ai)) return `The AI was not called (${why(q.ai)}); its questions stay open, which closes nothing.`;
  return `AI asked about item and ruled-out items${Object.keys(q.aiFacts || {}).includes('quantityMatchesMandate') ? ' and quantity' : ''} (${quickAiSource(q.ai)}).`;
}

/** The deep check's line under its title. */
export function deepAiSource(inv) {
  if (skipped(inv.ai)) return `The investigator was not called (${why(inv.ai)}). Its key counts as "nobody can be named"; code still checked the records it can.`;
  return inv.ai?.provider === 'fixture'
    ? 'AI not connected: the investigator’s answers here are stand-ins from our answer key. Code checked the quote against that step.'
    : `The investigator (${esc(inv.ai?.model || inv.ai?.provider || 'AI')}${replayed(inv.ai) ? `, ${REPLAYED}` : ''}) read every record; code then checked its quote against that step.`;
}

/** The AI key box's source line. */
export function aiKeySource(key, inv) {
  if (key.source === 'fixture-default') return 'Stand-in: no hand-written verdict, so it reads the records the way the rules do';
  if (inv.ai?.provider === 'fixture') return 'Stand-in answer from our answer key (AI not connected)';
  if (skipped(inv.ai)) return `AI not called (${why(inv.ai)})`;
  return `The investigator, ${esc(inv.ai?.model || inv.ai?.provider || 'AI')}${replayed(inv.ai) ? `, ${REPLAYED}` : ''}`;
}

/** What "both keys name the buyer" leads to. Over the limit the check came first and nothing was refunded. */
export function buyerKeysLine(kase) {
  return kase?.refund
    ? 'That only sends a notice. The re-charge waits for the notice period and stops on a dispute.'
    : 'No refund was paid, so there is nothing to take back. The buyer can still dispute this decision.';
}
