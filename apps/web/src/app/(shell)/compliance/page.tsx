"use client";

import { assetKey, assetLabel, useRun } from "@/lib/run-context";
import { Eyebrow, MiniChip } from "@/components/ui";
import type { MiniChipTone } from "@campaignfoundry/ui";

/** Automated compliance report — one row per generated asset. */
export default function CompliancePage() {
  const { assets, hasRun } = useRun();

  return (
    <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col p-4 pb-12 sm:p-8">
      <Eyebrow>Compliance</Eyebrow>
      <h2 className="mb-6 text-lg font-semibold text-text-emphasis">Automated Compliance Report</h2>

      <div className="w-full overflow-x-auto rounded-xl border border-border bg-surface shadow-2xl">
        <table className="w-full min-w-[640px] text-left text-[13px]">
          <thead className="border-b border-border bg-surface-2 text-text-muted">
            <tr>
              <Eyebrow as="th" className="p-4 font-normal">
                Asset Target
              </Eyebrow>
              <Eyebrow as="th" className="p-4 font-normal">
                Rule Engine
              </Eyebrow>
              <Eyebrow as="th" className="p-4 font-normal">
                Telemetry Result
              </Eyebrow>
              <Eyebrow as="th" className="p-4 font-normal">
                Gate Status
              </Eyebrow>
            </tr>
          </thead>
          <tbody className="divide-y divide-border text-text-emphasis">
            {!hasRun || assets.length === 0 ? (
              <tr className="opacity-50">
                <td className="p-4 font-mono">—</td>
                <td className="p-4">Brand Density + Logo</td>
                <td className="p-4 text-text-muted">Awaiting pipeline execution…</td>
                <td className="p-4">
                  <GateBadge status="pending" />
                </td>
              </tr>
            ) : (
              assets.flatMap((asset) => [
                <tr key={assetKey(asset)}>
                  <td className="p-4 font-mono">{assetLabel(asset)}</td>
                  <td className="p-4">Brand Density + Logo</td>
                  <td className="p-4 text-text-muted">
                    Brand-colour density {(asset.complianceScore * 100).toFixed(1)}%
                    {asset.passedCompliance ? " — at or above threshold" : " — below threshold"};
                    logo {asset.logoApplied ? "present" : "missing"}.
                  </td>
                  <td className="p-4">
                    <GateBadge
                      status={asset.passedCompliance && asset.logoApplied ? "pass" : "fail"}
                    />
                  </td>
                </tr>,
                // D136: the layer-order finding is a third member of this
                // family, on this surface rather than a parallel one — a
                // product with two places that answer "is this creative sound?"
                // is the two-sources-of-truth defect the arc exists to remove.
                // Its own row, because it is a different check with a different
                // verdict: an advisory never turns the density gate red.
                ...(asset.occlusionAdvisories ?? []).map((advisory, index) => (
                  <tr key={`${assetKey(asset)}::occlusion::${index}`}>
                    <td className="p-4 font-mono">{assetLabel(asset)}</td>
                    <td className="p-4">Layer Order</td>
                    <td className="p-4 text-text-muted">{advisory}</td>
                    <td className="p-4">
                      <GateBadge status="advisory" />
                    </td>
                  </tr>
                )),
              ])
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * The verdict chip. `advisory` (D136) is deliberately NOT a fail: D135 says a
 * reorder that hides or mutes a layer warns and never refuses, so a
 * layer-order finding must never read as a gate the operator has to clear.
 */
const GATE_TONES: Record<GateStatus, MiniChipTone> = {
  pass: "success",
  fail: "error",
  advisory: "warning",
  pending: "neutral",
};

const GATE_LABELS: Record<GateStatus, string> = {
  pass: "PASS",
  fail: "FAIL",
  advisory: "ADVISORY",
  pending: "PENDING",
};

type GateStatus = "pass" | "fail" | "advisory" | "pending";

function GateBadge({ status }: { status: GateStatus }) {
  return <MiniChip tone={GATE_TONES[status]}>{GATE_LABELS[status]}</MiniChip>;
}
