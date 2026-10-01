import { describe, expect, test } from "vitest";
import { fetchStub, json } from "./fixtures.js";
import {
  ALLOWED_PATHS,
  GLOBAL_EVENT_PATH,
  LOOPBACK_HOSTS,
  SESSION_ID,
  checkServer,
  checkSession,
  makeGet,
  sessionPath,
} from "../lib/server.js";

const SERVER = "http://127.0.0.1:4096";
const SESSION = "ses_abc123";

describe("checkServer", () => {
  test("accepts the ocm tunnel's three spellings and returns the bare origin", async () => {
    // `[::1]` is the LITERAL hostname Node produces for an IPv6 literal, so the
    // allowlist holds the bracketed form; a bare `::1` would never match.
    for (const [raw, origin] of [
      ["http://127.0.0.1:4096", "http://127.0.0.1:4096"],
      ["http://localhost:4096", "http://localhost:4096"],
      ["http://[::1]:4096", "http://[::1]:4096"],
      ["http://127.0.0.1", "http://127.0.0.1"],
    ] as const) {
      expect(checkServer(raw), raw).toBe(origin);
      expect(LOOPBACK_HOSTS.has(new URL(raw).hostname), raw).toBe(true);
    }
  });

  test("drops a typed path or credentials, so neither can ride along on a request", async () => {
    // What reaches `get` is scheme://host:port and nothing else, so no
    // operator-typed path can become a prefix on every request this tool makes.
    expect(checkServer("http://127.0.0.1:4096/api/")).toBe("http://127.0.0.1:4096");
    expect(checkServer("http://user:pass@127.0.0.1:4096")).toBe("http://127.0.0.1:4096");
  });

  test("refuses anything that is not an http URL on the tunnel", async () => {
    for (const raw of [
      "https://127.0.0.1:4096",
      "file:///etc/passwd",
      "ws://127.0.0.1:4096",
      "http://127.0.0.1.evil.com:4096",
      "http://[::2]:4096",
      "127.0.0.1:4096",
      "",
    ]) {
      expect(() => checkServer(raw), raw).toThrow(/lane:watch/);
    }
  });
});

describe("checkSession", () => {
  test("accepts ses_ followed by alphanumerics, and nothing else", async () => {
    for (const id of ["ses_a", "ses_ABC123", "ses_0123456789"]) {
      expect(checkSession(id), id).toBe(id);
    }
    for (const id of [
      "ses_",
      "ses",
      "abc",
      "ses_a-b",
      "ses_a_b",
      "SES_a",
      "ses_a/b",
      "../ses_a",
      "",
    ]) {
      expect(() => checkSession(id), id).toThrow(SESSION_ID.source);
    }
  });
});

describe("makeGet", () => {
  test("sends only GET, with redirects refused, to the two allowlisted paths", async () => {
    const stub = fetchStub([json({ ok: true })]);
    const get = makeGet(SERVER, stub.fetch);
    const controller = new AbortController();
    for (const path of [GLOBAL_EVENT_PATH, sessionPath(SESSION)]) {
      await get(path, controller.signal);
    }
    expect(stub.calls.map((call) => call.pathname)).toEqual([
      "/global/event",
      `/session/${SESSION}`,
    ]);
    for (const call of stub.calls) {
      expect(call.method).toBe("GET");
      expect(call.redirect).toBe("error");
      expect(call.url.startsWith(`${SERVER}/`)).toBe(true);
      expect(call.signal).toBe(controller.signal);
    }
  });

  test("refuses any other path instead of requesting it", async () => {
    // The allowlist is what makes "this tool reads two things" structural. A
    // caller reaching for a third path gets a refusal, and the refusal is
    // raised BEFORE any request is built.
    const stub = fetchStub([json({ ok: true })]);
    const get = makeGet(SERVER, stub.fetch);
    const controller = new AbortController();
    for (const path of [
      "/session",
      "/session/",
      "/global",
      "/global/event/extra",
      "/config",
      "/session/ses_abc/../ses_def",
      "/session/not-a-session",
      "//evil.example/global/event",
      "/global/event?directory=/etc",
    ]) {
      expect(ALLOWED_PATHS.test(path), path).toBe(false);
      await expect(get(path, controller.signal), path).rejects.toThrow("not one of the two paths");
    }
    expect(stub.calls).toEqual([]);
  });

  test("the allowlist is exactly the session read and the event stream", async () => {
    expect(ALLOWED_PATHS.test(GLOBAL_EVENT_PATH)).toBe(true);
    expect(ALLOWED_PATHS.test(sessionPath(SESSION))).toBe(true);
    expect(ALLOWED_PATHS.test(sessionPath("not-a-session"))).toBe(false);
  });
});
