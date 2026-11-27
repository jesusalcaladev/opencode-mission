// Pure helpers for review rework accounting. The same finding must not reopen
// every task and reset every attempt on each review cycle.

export const reviewFingerprint = (text = "") =>
  String(text ?? "")
    .trim()
    .slice(0, 300);

export function alreadyReworked(state = {}, fingerprint = "") {
  return Boolean(fingerprint) && (state.review_fingerprints ?? []).includes(fingerprint);
}
