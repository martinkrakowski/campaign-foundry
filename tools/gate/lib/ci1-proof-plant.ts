// PROOF PLANT for PR #715 (step 3): a source file no test loads. Every shard must stay green and
// the coverage job must fail on it. Removed before merge.
export function ci1ProofPlant(value: number): string {
  if (value > 0) return "positive";
  return "not positive";
}
