"use client";

import { assetKey, useRun } from "@/lib/run-context";
import { cn } from "@/lib/cn";

/** Automated compliance report — one row per generated asset. */
export default function CompliancePage() {
  const { assets, hasRun } = useRun();

  return (
    <div className="flex h-full flex-col items-start p-8 pb-40">
      <h2 className="mb-6 text-xl font-bold text-white">Automated Compliance Report</h2>

      <div className="w-full max-w-4xl overflow-hidden rounded-xl border border-border bg-surface shadow-2xl">
        <table className="w-full text-left text-[13px]">
          <thead className="border-b border-border bg-surface-2 text-text-muted">
            <tr>
              <th className="p-4 font-medium">Asset Target</th>
              <th className="p-4 font-medium">Rule Engine</th>
              <th className="p-4 font-medium">Telemetry Result</th>
              <th className="p-4 font-medium">Gate Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border text-white">
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
                    {asset.productId} @ {asset.aspectRatio} · {asset.treatment}
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
  const label = status === "pass" ? "PASS" : status === "fail" ? "FAIL" : "PENDING";
  return (
    <span
      className={cn(
        "rounded border px-2 py-1 font-mono text-xs",
        status === "pass" && "border-success/30 bg-success/20 text-success",
        status === "fail" && "border-error/30 bg-error/20 text-error",
        status === "pending" && "border-border bg-surface-2 text-text-muted",
      )}
    >
      {label}
    </span>
  );
}
