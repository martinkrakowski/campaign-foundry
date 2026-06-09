import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLEAR = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENROUTER_API_KEY", "FIREFLY_CLIENT_ID", "FIREFLY_CLIENT_SECRET", "A", "B", "C", "D", "E", "X"];

/** Fresh module so the `loaded` flag starts false each test. */
const loadFresh = async () => {
  vi.resetModules();
  return (await import("../env.js")).loadEnv;
};

describe("loadEnv", () => {
  let dir: string;
  let snapshot: NodeJS.ProcessEnv;
  const origCwd = process.cwd();

  beforeEach(() => {
    snapshot = { ...process.env };
    dir = mkdtempSync(join(tmpdir(), "cf-env-"));
    process.env.PROJECT_ROOT = dir; // cwd and projectRoot both = dir → one source dir
    process.chdir(dir);
    for (const k of CLEAR) delete process.env[k];
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) if (!(k in snapshot)) delete process.env[k];
    for (const k of Object.keys(snapshot)) process.env[k] = snapshot[k] as string;
    vi.restoreAllMocks();
  });

  const writeEnv = (name: string, content: string) => writeFileSync(join(dir, name), content);

  test("parses values, strips quotes, skips comment/blank/no-eq lines, never overrides", async () => {
    process.env.D = "orig";
    writeEnv(".env.local", ['A="quoted"', "B='single'", "C=plain", "# comment", "", "NOEQ", "D=new"].join("\n"));
    (await loadFresh())();
    expect(process.env.A).toBe("quoted");
    expect(process.env.B).toBe("single");
    expect(process.env.C).toBe("plain");
    expect(process.env.D).toBe("orig"); // pre-set value is not overridden
  });

  test(".env.local takes precedence over .env", async () => {
    writeEnv(".env.local", "E=local");
    writeEnv(".env", "E=fromenv");
    (await loadFresh())();
    expect(process.env.E).toBe("local");
  });

  test("logs imagen via GEMINI_API_KEY and openrouter when both keys are present", async () => {
    writeEnv(".env.local", "GEMINI_API_KEY=g\nOPENROUTER_API_KEY=o");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    (await loadFresh())();
    const printed = log.mock.calls.flat().join(" ");
    expect(printed).toMatch(/imagen \(GEMINI_API_KEY/);
    expect(printed).toMatch(/openrouter \(OPENROUTER_API_KEY/);
  });

  test("names GOOGLE_API_KEY when GEMINI is absent", async () => {
    writeEnv(".env.local", "GOOGLE_API_KEY=g");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    (await loadFresh())();
    expect(log.mock.calls.flat().join(" ")).toMatch(/imagen \(GOOGLE_API_KEY/);
  });

  test("logs firefly when both IMS credentials are present", async () => {
    writeEnv(".env.local", "FIREFLY_CLIENT_ID=cid\nFIREFLY_CLIENT_SECRET=secret");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    (await loadFresh())();
    expect(log.mock.calls.flat().join(" ")).toMatch(/firefly \(FIREFLY_CLIENT_ID/);
  });

  test("warns when Firefly is half-configured and does not list it as a provider", async () => {
    writeEnv(".env.local", "FIREFLY_CLIENT_ID=cid");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    (await loadFresh())();
    const warned = warn.mock.calls.flat().join(" ");
    expect(warned).toMatch(/FIREFLY_CLIENT_SECRET is missing/);
    expect(warned).toMatch(/procedural only/); // credentials alone don't enable a provider
  });

  test("warns when no GenAI keys are present", async () => {
    writeEnv(".env.local", "X=y");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    (await loadFresh())();
    expect(warn.mock.calls.flat().join(" ")).toMatch(/procedural only/);
  });

  test("is idempotent — a second call does nothing", async () => {
    writeEnv(".env.local", "X=y");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const loadEnv = await loadFresh();
    loadEnv();
    loadEnv();
    expect(warn).toHaveBeenCalledOnce();
  });
});
