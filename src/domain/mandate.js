// A mandate is what the buyer told the agent, turned into condition slots the buyer approved once.
// The desk keeps three things separately: the original instruction text, the approval record
// (when, and the exact condition text that was approved), and a SHA-256 fingerprint of both.
// The fingerprint is written into the PayPal order (custom_id), so a later check can show that the
// record being compared is the one that existed before the purchase. A hash alone does not make a
// record tamper-proof; the claim here is narrower: "compared against the record kept before purchase".
import { createHash } from 'node:crypto';

export function normalizeConditions(c) {
  return {
    item: String(c.item || '').trim(),
    quantity: c.quantity == null ? null : Number(c.quantity),
    maxTotalCents: c.maxTotalCents == null ? null : Number(c.maxTotalCents),
    exclusions: (c.exclusions || []).map((e) => String(e).trim()).filter(Boolean),
    // false = the buyer asked the agent to look, compare or prepare, but not to pay.
    purchaseAuthorized: Boolean(c.purchaseAuthorized),
  };
}

export function conditionsAsText(c) {
  const lines = [
    `Item: ${c.item || '(not specified)'}`,
    `Quantity: ${c.quantity == null ? '(not specified)' : c.quantity}`,
    `Spending limit: ${c.maxTotalCents == null ? '(none)' : `$${(c.maxTotalCents / 100).toFixed(2)} total`}`,
    `Must not include: ${c.exclusions.length ? c.exclusions.join('; ') : '(nothing listed)'}`,
    `May the agent pay without asking again: ${c.purchaseAuthorized ? 'yes' : 'no'}`,
  ];
  return lines.join('\n');
}

export function fingerprintMandate({ instruction, conditions, approvedAt }) {
  const canonical = JSON.stringify({ instruction, conditions: normalizeConditions(conditions), approvedAt });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
