import { pathToFileURL } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import {
  parseArgs,
  runMutation,
  formatReport,
  RefusalError,
  EXIT_CAUGHT,
  EXIT_SURVIVED,
  EXIT_REFUSAL,
} from "./lib/mutate.js";
import type { MutationDeps } from "./lib/types.js";

export const realDeps: MutationDeps = {
  readFile: async (path: string) => readFile(path, "utf8"),
  readFileBuffer: async (path: string) => readFile(path),
  writeFileBuffer: async (path: string, content: Buffer) => writeFile(path, content),
  execute: async (command: readonly string[]) => {
    return new Promise((resolve, reject) => {
      const [cmd, ...args] = command;
      if (!cmd) {
        reject(new Error("empty command"));
        return;
      }
      const child = spawn(cmd, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString("utf8");
      });
      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString("utf8");
      });

      child.on("error", (err) => {
        reject(err);
      });

      child.on("close", (code) => {
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr,
        });
      });
    });
  },
  onSignal: (cleanup) => {
    let cleanPromise: Promise<void> | null = null;
    const handler = () => {
      if (!cleanPromise) {
        cleanPromise = (async () => {
          try {
            await cleanup();
            process.exit(130);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(message);
            process.exit(EXIT_REFUSAL);
          }
        })();
      }
    };
    process.on("SIGINT", handler);
    process.on("SIGTERM", handler);
    process.on("SIGHUP", handler);
    return () => {
      process.off("SIGINT", handler);
      process.off("SIGTERM", handler);
      process.off("SIGHUP", handler);
    };
  },
};

export interface MutateCliIo {
  readonly argv: readonly string[];
  readonly log: (text: string) => void;
  readonly logError: (text: string) => void;
  readonly deps?: MutationDeps;
}

export async function runCli(io: MutateCliIo): Promise<number> {
  const deps = io.deps ?? realDeps;
  try {
    const args = parseArgs(io.argv);
    const result = await runMutation(args, deps);
    io.log(formatReport(result));
    return result.verdict === "caught" ? EXIT_CAUGHT : EXIT_SURVIVED;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.logError(message);
    if (error instanceof RefusalError) {
      return error.exitCode;
    }
    return EXIT_REFUSAL;
  }
}

/* istanbul ignore next -- CLI entry guard; runCli() is covered directly in tests */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli({
    argv: process.argv.slice(2),
    log: (text) => console.log(text),
    logError: (text) => console.error(text),
    deps: realDeps,
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = EXIT_REFUSAL;
    });
}
