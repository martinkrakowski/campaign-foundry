"use client";

import { assetKey, assetLabel, useRun } from "@/lib/run-context";
import { Eyebrow, MiniChip } from "@/components/ui";

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
              <Eyebrow as="th" className="p-4 font-normal">Asset Target</Eyebrow>
              <Eyebrow as="th" className="p-4 font-normal">Rule Engine</Eyebrow>
              <Eyebrow as="th" className="p-4 font-normal">Telemetry Result</Eyebrow>
              <Eyebrow as="th" className="p-4 font-normal">Gate Status</Eyebrow>
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
              assets.map((asset) => (
                <tr key={assetKey(asset)}>
                  <td className="p-4 font-mono">
                    {assetLabel(asset)}
                  </td>
                  <td className="p-4">Brand Density + Logo</td>
                  <td className="p-4 text-text-muted">
                    Brand-colour density {(asset.complianceScore * 100).toFixed(1)}%
                    {asset.passedCompliance ? " — at or above threshold" : " — below threshold"}; logo{" "}
                    {asset.logoApplied ? "present" : "missing"}.
                  </td>
                  <td className="p-4">
                    <GateBadge status={asset.passedCompliance && asset.logoApplied ? "pass" : "fail"} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function GateBadge({ status }: { status: "pass" | "fail" | "pending" }) {
  const tone = status === "pass" ? "success" : status === "fail" ? "error" : "neutral";
  const label = status === "pass" ? "PASS" : status === "fail" ? "FAIL" : "PENDING";
  return <MiniChip tone={tone}>{label}</MiniChip>;
}
