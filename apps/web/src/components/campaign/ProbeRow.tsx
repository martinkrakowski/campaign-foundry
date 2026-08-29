import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface ProbeRowProps {
  readonly capabilities: { motion: boolean; reason?: string; version?: string } | null;
  readonly className?: string;
}

/**
 * Operational probe readout row (D8 / §3.3).
 *
 * Displays the host's ffmpeg status:
 * - Probing: "ffmpeg · probing…"
 * - Found: "ffmpeg · found · 6.1"
 * - Not available: "ffmpeg · not available · <reason>"
 */
export function ProbeRow({ capabilities, className }: ProbeRowProps): ReactNode {
  const isProbing = capabilities === null || capabilities.reason === "not probed";
  const isFound = !isProbing && capabilities.motion === true;
  const isUnavailable = !isProbing && capabilities.motion === false;

  return (
    <div
      aria-label="Capabilities probe"
      className={cn(
        "flex items-center gap-2 font-mono text-[11px] text-text-muted",
        className,
      )}
    >
      <span className="flex items-center gap-1.5">
        {isProbing && (
          <span className="inline-block size-2 rounded-full bg-info/80 animate-pulse" aria-hidden="true" />
        )}
        {isFound && (
          <span className="inline-block size-2 rounded-full bg-success" aria-hidden="true" />
        )}
        {isUnavailable && (
          <span className="inline-block size-2 rounded-full bg-warning" aria-hidden="true" />
        )}
        <span>ffmpeg</span>
      </span>
      <span>·</span>
      {isProbing && <span>probing…</span>}
      {isFound && (
        <span>
          found{capabilities?.version ? ` · ${capabilities.version}` : ""}
        </span>
      )}
      {isUnavailable && (
        <span className="text-text-muted">
          not available{capabilities?.reason ? ` · ${capabilities.reason}` : ""}
        </span>
      )}
    </div>
  );
}
