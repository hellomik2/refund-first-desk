// Who answered, in the words the page shows. A prepared case replays an answer Claude gave in an earlier
// live run ("recorded"); the page says so wherever it names the model, so a replay never reads as a live call.
// Pure string functions, so the tests can read them without a browser.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const REPLAYED = 'recorded answer replayed';
const replayed = (ai) => ai?.provider === 'recorded';

/** Header pill: the desk's AI, and whether the latest answer on the case on screen (deep check, else quick) was replayed. */
export function aiPillText(flags, kase) {
  if (flags.aiProvider === 'fixture') return 'AI not connected: stand-in answers';
  if (flags.aiProvider === 'recorded') return 'AI: recorded answers replayed';
  const model = flags.aiModel || flags.aiProvider;
  return replayed(kase?.investigation?.ai || kase?.quick?.ai) ? `AI: ${model}, ${REPLAYED}` : `AI: ${model}`;
}

/** The quick check's "who answered", inside the brackets after its line. */
export function quickAiSource(ai) {
  return ai.provider === 'fixture' ? 'stand-in answers' : `${esc(ai.model || ai.provider)}${replayed(ai) ? `, ${REPLAYED}` : ''}`;
}

/** The deep check's line under its title. */
export function deepAiSource(inv) {
  return inv.ai?.provider === 'fixture'
    ? 'AI not connected: the investigator’s answers here are stand-ins from our answer key. Code checked the quote against that step.'
    : `The investigator (${esc(inv.ai?.model || inv.ai?.provider || 'AI')}${replayed(inv.ai) ? `, ${REPLAYED}` : ''}) read every record; code then checked its quote against that step.`;
}

/** The AI key box's source line. */
export function aiKeySource(key, inv) {
  if (key.source === 'fixture-default') return 'Stand-in: no hand-written verdict, so it reads the records the way the rules do';
  if (inv.ai?.provider === 'fixture') return 'Stand-in answer from our answer key (AI not connected)';
  return `The investigator, ${esc(inv.ai?.model || inv.ai?.provider || 'AI')}${replayed(inv.ai) ? `, ${REPLAYED}` : ''}`;
}

/** What "both keys name the buyer" leads to. Over the limit the check came first and nothing was refunded. */
export function buyerKeysLine(kase) {
  return kase?.refund
    ? 'That only sends a notice. The re-charge waits for the notice period and stops on a dispute.'
    : 'No refund was paid, so there is nothing to take back. The buyer can still dispute this decision.';
}
