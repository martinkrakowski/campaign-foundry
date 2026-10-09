import type { CollectedBlock } from "./collect.js";

/** Result of rendering: the file text plus the counts the CLI reports. */
export interface RenderResult {
  readonly text: string;
  readonly blocksWritten: number;
  readonly blocksDropped: number;
  readonly totalTokens: number;
}

/** The verbatim header lines (before the counts line is appended). */
const HEADER = [
  "# Reference code from the base commit ",
  "# This is NOT part of the change under review. It is unchanged code the change depends on,",
  "# read from the base commit. A finding whose fix lies in this file is not posted.",
];

function makeFence(text: string): string {
  let maxRun = 0;
  let current = 0;
  for (const ch of text) {
    if (ch === "`") {
      current++;
      if (current > maxRun) maxRun = current;
    } else {
      current = 0;
    }
  }
  return "`".repeat(Math.max(3, maxRun + 1));
}

function renderBlock(block: CollectedBlock): string {
  const fence = makeFence(block.text);
  return (
    `## ${block.path}:${block.startLine}-${block.endLine} ${block.symbol}` +
    `\nwhy: ${block.why}` +
    `\n${fence}\n${block.text}\n${fence}`
  );
}

export function render(
  base: string,
  blocks: readonly CollectedBlock[],
  maxTokens: number,
): RenderResult {
  let written = 0;
  let dropped = 0;
  let runningTokens = 0;
  const parts: string[] = [];

  for (const block of blocks) {
    const blockText = renderBlock(block);
    const tokens = Math.ceil(blockText.length / 4);
    if (runningTokens + tokens > maxTokens) {
      dropped++;
      continue;
    }
    runningTokens += tokens;
    written++;
    parts.push(blockText);
  }

  const header = [
    `${HEADER[0]}${base}`,
    HEADER[1],
    HEADER[2],
    `# ${written} block(s), ${dropped} dropped for budget`,
  ];

  return {
    text: [...header, ...parts].join("\n"),
    blocksWritten: written,
    blocksDropped: dropped,
    totalTokens: runningTokens,
  };
}
