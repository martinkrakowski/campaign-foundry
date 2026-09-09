export type Verdict = "caught" | "survived";

export interface ParsedMutateArgs {
  readonly file: string;
  readonly before: string;
  readonly after: string;
  readonly because: string;
  readonly command: readonly string[];
}

export interface MutationResult {
  readonly exitCode: number;
  readonly verdict: Verdict;
  readonly because: string;
  readonly stdout: string;
  readonly stderr: string;
}

export interface MutationDeps {
  readonly readFile: (path: string) => Promise<string>;
  readonly readFileBuffer: (path: string) => Promise<Buffer>;
  readonly writeFileBuffer: (path: string, content: Buffer) => Promise<void>;
  readonly execute: (command: readonly string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  readonly onSignal?: (cleanup: () => Promise<void> | void) => () => void;
}
