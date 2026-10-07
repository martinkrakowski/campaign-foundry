import { afterAll, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SCRIPT = fileURLToPath(new URL("../../../scripts/verify-manifests.sh", import.meta.url));
const MATRIX = fileURLToPath(new URL("../../../scripts/mutation-matrix.sh", import.meta.url));

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function makeDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `verify-manifests-plan-${label}-`));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  }
}

function setupRepo(
  dir: string,
  manifests: Record<string, string>,
  extraFiles: Record<string, string> = {},
): void {
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "user.email", "test@test.com"]);
  git(dir, ["checkout", "-b", "main", "-q"]);
  mkdirSync(join(dir, ".agents", "manifests"), { recursive: true });
  writeFileSync(join(dir, ".agents", "manifests", ".keep"), "");
  for (const [name, content] of Object.entries(manifests)) {
    writeFileSync(join(dir, ".agents", "manifests", name), content);
  }
  for (const [name, content] of Object.entries(extraFiles)) {
    mkdirSync(join(dir, ...name.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial"]);
  git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
}

function makeManifest(mutations: number): string {
  const mlist = Array.from({ length: mutations }, (_, i) => ({
    file: `f${i}.ts`,
    before: `before${i}`,
    after: `after${i}`,
    because: "test",
    command: ["true"],
    verdict: "caught",
  }));
  return JSON.stringify({ version: 1, lane: "t", mutations: mlist });
}

const stubManifest = (live: number, retired: number = 0) => {
  const mutations: any[] = [];
  for (let i = 0; i < live; i++)
    mutations.push({
      file: `f${i}.ts`,
      before: `b${i}`,
      after: `a${i}`,
      because: "t",
      command: ["true"],
      verdict: "caught",
    });
  for (let i = 0; i < retired; i++)
    mutations.push({
      file: `r${i}.ts`,
      before: `rb${i}`,
      after: `ra${i}`,
      because: "t",
      command: ["true"],
      verdict: "caught",
      retired: "old",
    });
  return JSON.stringify({ version: 1, lane: "t", mutations });
};

describe("verify-manifests.sh --list", () => {
  test("no manifest changed (README only)", () => {
    const dir = makeDir("nolist");
    setupRepo(dir, { "a.json": makeManifest(1) });
    writeFileSync(join(dir, "README.md"), "# test");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "README"]);

    const r = spawnSync("sh", [SCRIPT, "--list"], {
      cwd: dir,
      env: { ...process.env, GITHUB_BASE_REF: "main" },
      encoding: "utf8",
    });

    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("one changed manifest", () => {
    const dir = makeDir("onelist");
    setupRepo(dir, { "a.json": makeManifest(1) });
    writeFileSync(join(dir, ".agents", "manifests", "b.json"), makeManifest(1));
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "add manifest"]);

    const r = spawnSync("sh", [SCRIPT, "--list"], {
      cwd: dir,
      env: { ...process.env, GITHUB_BASE_REF: "main" },
      encoding: "utf8",
    });

    expect(r.status).toBe(0);
    expect(r.stdout.split("\n").filter((l) => l)).toEqual([".agents/manifests/b.json"]);
  });

  test("several changed manifests (sorted)", () => {
    const dir = makeDir("manylist");
    setupRepo(dir, { "a.json": makeManifest(1) });
    writeFileSync(join(dir, ".agents", "manifests", "b.json"), makeManifest(1));
    writeFileSync(join(dir, ".agents", "manifests", "c.json"), makeManifest(1));
    writeFileSync(join(dir, ".agents", "manifests", "d.json"), makeManifest(1));
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "add manifests"]);

    const r = spawnSync("sh", [SCRIPT, "--list"], {
      cwd: dir,
      env: { ...process.env, GITHUB_BASE_REF: "main" },
      encoding: "utf8",
    });

    expect(r.status).toBe(0);
    const out = r.stdout.split("\n").filter((l) => l);
    expect(out).toContain(".agents/manifests/b.json");
    expect(out).toContain(".agents/manifests/c.json");
    expect(out).toContain(".agents/manifests/d.json");
  });

  test("one deleted plus one changed (only changed printed)", () => {
    const dir = makeDir("deletelist");
    setupRepo(dir, { "a.json": makeManifest(1), "b.json": makeManifest(1) });
    rmSync(join(dir, ".agents", "manifests", "b.json"));
    writeFileSync(join(dir, ".agents", "manifests", "c.json"), makeManifest(1));
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "delete b, add c"]);

    const r = spawnSync("sh", [SCRIPT, "--list"], {
      cwd: dir,
      env: { ...process.env, GITHUB_BASE_REF: "main" },
      encoding: "utf8",
    });

    expect(r.status).toBe(0);
    const out = r.stdout.split("\n").filter((l) => l);
    expect(out).toEqual([".agents/manifests/c.json"]);
  });

  test("unresolvable non-hex base exits 2", () => {
    const dir = makeDir("badbase");
    setupRepo(dir, { "a.json": makeManifest(1) });
    writeFileSync(join(dir, ".agents", "manifests", "b.json"), makeManifest(1));
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "add"]);

    const r = spawnSync("sh", [SCRIPT, "--list"], {
      cwd: dir,
      env: { ...process.env, GITHUB_BASE_REF: "", MANIFEST_DIFF_BASE: "nope" },
      encoding: "utf8",
    });

    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/not a resolvable commit/);
  });

  test("manifest named é.json makes --list exit 2", () => {
    const dir = makeDir("accent");
    setupRepo(dir, { "a.json": makeManifest(1) });
    writeFileSync(join(dir, ".agents", "manifests", "é.json"), makeManifest(1));
    writeFileSync(join(dir, ".agents", "manifests", "é.json.gitattributes"), "* -text\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "add accent"]);

    const r = spawnSync("sh", [SCRIPT, "--list"], {
      cwd: dir,
      env: { ...process.env, GITHUB_BASE_REF: "main" },
      encoding: "utf8",
    });

    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/quoted name/);
  });
});

describe("verify-manifests.sh --replay", () => {
  test("--replay with empty stdin exits 2", () => {
    const dir = makeDir("replayempty");
    setupRepo(dir, { "a.json": makeManifest(1) });

    const r = spawnSync("sh", [SCRIPT, "--replay"], {
      cwd: dir,
      input: "",
      env: { ...process.env, MANIFEST_DIFF_BASE: "HEAD~1" },
      encoding: "utf8",
    });

    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/no manifest/);
  });

  test("--replay with a listed manifest and no manifests directory fails instead of skipping", () => {
    const dir = makeDir("replaynodir");
    setupRepo(dir, { "a.json": makeManifest(1) });
    rmSync(join(dir, ".agents", "manifests"), { recursive: true, force: true });

    const r = spawnSync("sh", [SCRIPT, "--replay"], {
      cwd: dir,
      input: ".agents/manifests/a.json\n",
      env: { ...process.env, MANIFEST_DIFF_BASE: "HEAD~1" },
      encoding: "utf8",
    });

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/does not exist/);
    expect(r.stdout + r.stderr).not.toMatch(/nothing to replay/);
  });

  test("--replay with non-existent path exits non-zero", () => {
    const dir = makeDir("replaybad");
    setupRepo(dir, { "a.json": makeManifest(1) });

    const r = spawnSync("sh", [SCRIPT, "--replay"], {
      cwd: dir,
      input: ".agents/manifests/missing.json\n",
      env: { ...process.env, MANIFEST_DIFF_BASE: "HEAD~1" },
      encoding: "utf8",
    });

    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/does not exist/);
  });

  test("--replay with trailing newline missing exits 2", () => {
    const dir = makeDir("replaynonl");
    setupRepo(dir, { "a.json": makeManifest(1) });

    const r = spawnSync("sh", [SCRIPT, "--replay"], {
      cwd: dir,
      input: ".agents/manifests/a.json",
      env: { ...process.env, MANIFEST_DIFF_BASE: "HEAD~1" },
      encoding: "utf8",
    });

    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/refusing to call that a replay/);
  });

  test("--replay with two non-existent paths prints does not exist twice and exits 1", () => {
    const dir = makeDir("replaysdouble");
    setupRepo(dir, { "a.json": makeManifest(1) });

    const r = spawnSync("sh", [SCRIPT, "--replay"], {
      cwd: dir,
      input: ".agents/manifests/missing1.json\n.agents/manifests/missing2.json\n",
      env: { ...process.env, MANIFEST_DIFF_BASE: "HEAD~1" },
      encoding: "utf8",
    });

    expect(r.status).toBe(1);
    const matches = (r.stderr.match(/does not exist/g) || []).length;
    expect(matches).toBe(2);
  });
});

describe("verify-manifests.sh unknown argument", () => {
  test("unknown argument exits 2", () => {
    const dir = makeDir("unknownarg");
    setupRepo(dir, {});

    const r = spawnSync("sh", [SCRIPT, "--bogus"], {
      cwd: dir,
      encoding: "utf8",
    });

    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage/);
  });
});

describe("mutation-matrix.sh", () => {
  test("jq exists", () => {
    const r = spawnSync("jq", ["--version"], { encoding: "utf8" });
    expect(r.status).toBe(0);
  });

  test("0 paths gives exactly the sentinel", () => {
    const r = spawnSync("sh", [MATRIX], {
      input: "",
      env: { ...process.env, MAX_LEGS: "6" },
      encoding: "utf8",
    });

    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out).toEqual({ include: [{ name: "none", manifests: "" }] });
  });

  test("1 path gives one leg named after the file", () => {
    const dir = makeDir("matrix1");
    setupRepo(dir, {});
    writeFileSync(join(dir, ".agents", "manifests", "one.json"), stubManifest(5));
    const r = spawnSync("sh", [MATRIX], {
      input: ".agents/manifests/one.json\n",
      cwd: dir,
      env: { ...process.env, MAX_LEGS: "6" },
      encoding: "utf8",
    });

    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.include).toHaveLength(1);
    expect(out.include[0].name).toBe("one");
    expect(out.include[0].manifests).toBe(".agents/manifests/one.json");
  });

  test("6 paths give 6 legs", () => {
    const dir = makeDir("matrix6");
    setupRepo(dir, {});
    const names: string[] = [];
    for (let i = 0; i < 6; i++) {
      const name = `.agents/manifests/m${i}.json`;
      writeFileSync(join(dir, name), stubManifest(1));
      names.push(name);
    }
    const input = names.join("\n") + "\n";
    const r = spawnSync("sh", [MATRIX], {
      input,
      cwd: dir,
      env: { ...process.env, MAX_LEGS: "6" },
      encoding: "utf8",
    });

    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.include).toHaveLength(6);
    const result = out.include.map((l: any) => l.manifests).join("\n");
    const sortedResult = result.split("\n").sort().join("\n");
    const sortedInput = names.sort().join("\n");
    expect(sortedResult).toBe(sortedInput);
  });

  test("7 paths give group-1..group-6 and partition is correct", () => {
    const dir = makeDir("matrix7");
    setupRepo(dir, {});
    const names: string[] = [];
    for (let i = 0; i < 7; i++) {
      const name = `.agents/manifests/m${i}.json`;
      writeFileSync(join(dir, name), stubManifest(1));
      names.push(name);
    }
    const input = names.join("\n") + "\n";
    const r = spawnSync("sh", [MATRIX], {
      input,
      cwd: dir,
      env: { ...process.env, MAX_LEGS: "6" },
      encoding: "utf8",
    });

    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.include).toHaveLength(6);
    for (let i = 1; i <= 6; i++) {
      expect(out.include.some((l: any) => l.name === `group-${i}`)).toBe(true);
    }
    const allPaths = out.include.flatMap((l: any) => l.manifests.split("\n")).sort();
    expect(allPaths).toEqual(names.sort());
  });

  test("13 paths give group-1..group-6 and partition is correct", () => {
    const dir = makeDir("matrix13");
    setupRepo(dir, {});
    const names: string[] = [];
    for (let i = 0; i < 13; i++) {
      const name = `.agents/manifests/m${i}.json`;
      writeFileSync(join(dir, name), stubManifest(1));
      names.push(name);
    }
    const input = names.join("\n") + "\n";
    const r = spawnSync("sh", [MATRIX], {
      input,
      cwd: dir,
      env: { ...process.env, MAX_LEGS: "6" },
      encoding: "utf8",
    });

    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.include).toHaveLength(6);
    const allPaths = out.include.flatMap((l: any) => l.manifests.split("\n")).sort();
    expect(allPaths).toEqual(names.sort());
  });

  test("stub with 19 live mutations sits alone (LPT)", () => {
    const dir = makeDir("matrixlpt");
    setupRepo(dir, {});
    const sixNames: string[] = [];
    for (let i = 0; i < 6; i++) {
      const name = `.agents/manifests/s${i}.json`;
      writeFileSync(join(dir, name), stubManifest(1));
      sixNames.push(name);
    }
    const bigName = ".agents/manifests/big.json";
    writeFileSync(join(dir, bigName), stubManifest(19));
    const input = [...sixNames, bigName].join("\n") + "\n";
    const r = spawnSync("sh", [MATRIX], {
      input,
      cwd: dir,
      env: { ...process.env, MAX_LEGS: "6" },
      encoding: "utf8",
    });

    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    const bigLeg = out.include.find((l: any) => l.manifests.split("\n").includes(bigName));
    expect(bigLeg.manifests.split("\n")).toEqual([bigName]);
  });

  test("MAX_LEGS=0 exits 2", () => {
    const r = spawnSync("sh", [MATRIX], {
      input: "",
      env: { ...process.env, MAX_LEGS: "0" },
      encoding: "utf8",
    });

    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/MAX_LEGS must be a positive integer/);
  });

  test("MAX_LEGS=x exits 2", () => {
    const r = spawnSync("sh", [MATRIX], {
      input: "",
      env: { ...process.env, MAX_LEGS: "x" },
      encoding: "utf8",
    });

    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/MAX_LEGS must be a positive integer/);
  });

  test("malformed manifest weighs 1 and is still listed", () => {
    const dir = makeDir("matrixmalformed");
    setupRepo(dir, {});
    writeFileSync(join(dir, ".agents", "manifests", "bad.json"), "{not valid json");
    const r = spawnSync("sh", [MATRIX], {
      input: ".agents/manifests/bad.json\n",
      cwd: dir,
      env: { ...process.env, MAX_LEGS: "6" },
      encoding: "utf8",
    });

    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.include[0].manifests).toBe(".agents/manifests/bad.json");
  });

  test("MAX_LEGS=2 with five stubs shows group-1/group-2", () => {
    const dir = makeDir("matrixmaxlegs2");
    setupRepo(dir, {});
    const names: string[] = [];
    for (let i = 0; i < 5; i++) {
      const name = `.agents/manifests/m${i}.json`;
      writeFileSync(join(dir, name), stubManifest(1));
      names.push(name);
    }
    const input = names.join("\n") + "\n";
    const r = spawnSync("sh", [MATRIX], {
      input,
      cwd: dir,
      env: { ...process.env, MAX_LEGS: "2" },
      encoding: "utf8",
    });

    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.include).toHaveLength(2);
    expect(out.include.some((l: any) => l.name === "group-1")).toBe(true);
    expect(out.include.some((l: any) => l.name === "group-2")).toBe(true);
  });
});
