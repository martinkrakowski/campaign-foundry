import { afterEach, describe, expect, test, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { extractDarkBlock, extractRootBlock } from "../server.js";
import type { WaveStatus } from "../lib/types.js";

const PAGE_PATH = fileURLToPath(
  new URL("../public/index.html", import.meta.url),
);

const realTokensPath = fileURLToPath(
  new URL("../../../apps/web/src/styles/tokens.css", import.meta.url),
);

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  readonly url: string;
  closed = false;

  readonly listeners: Record<string, ((event: { data: string }) => void)[]> =
    {};

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(
    type: string,
    listener: (event: { data: string }) => void,
  ): void {
    (this.listeners[type] ??= []).push(listener);
  }

  emit(type: string, data: string): void {
    for (const listener of this.listeners[type] ?? []) {
      listener({ data });
    }
  }

  close(): void {
    this.closed = true;
  }
}

interface PageHandle {
  readonly window: Window;
  readonly fetches: string[];
  readonly intervals: Set<number>;
  readonly source: FakeEventSource;
  // Invokes the most recently registered setInterval handler once, as if a
  // real 10 s poll tick had fired — the harness never runs timers itself.
  readonly firePoll: () => void;
}

const windows: Window[] = [];

afterEach(() => {
  vi.useRealTimers();
  FakeEventSource.instances = [];
  while (windows.length > 0) {
    windows.pop()?.happyDOM.close();
  }
});

const statusAt = (detail?: Record<string, unknown>): WaveStatus =>
  ({
    generatedAt: "now",
    waves: [
      {
        id: "T",
        lanes: [
          {
            wave: "T",
            lane: "t1",
            reported:
              detail === undefined
                ? undefined
                : {
                    stage: "remediate",
                    event: "settled",
                    ts: "now",
                    detail,
                  },
            derived: { alive: false },
            disagreements: [],
          },
        ],
      },
    ],
  }) as WaveStatus;

// Two waves, five lanes: alive and not, and the three reported outcomes, plus
// one lane with no events at all. Four observed PRs — one lane has none — two
// open, two merged, one with failing checks.
const mixedStatus: WaveStatus = {
  generatedAt: "now",
  waves: [
    {
      id: "T",
      lanes: [
        {
          wave: "T",
          lane: "t1",
          reported: { stage: "remediate", event: "settled", ts: "now" },
          derived: {
            alive: true,
            pr: { number: 1, state: "open", checks: "pass" },
          },
          disagreements: [],
        },
        {
          wave: "T",
          lane: "t2",
          reported: { stage: "gate", event: "failed", ts: "now" },
          derived: {
            alive: false,
            pr: { number: 2, state: "open", checks: "fail" },
          },
          disagreements: [],
        },
        {
          wave: "T",
          lane: "t3",
          reported: { stage: "review", event: "started", ts: "now" },
          derived: { alive: true },
          disagreements: [],
        },
        {
          wave: "T",
          lane: "t4",
          derived: {
            alive: false,
            pr: { number: 3, state: "merged", checks: "none" },
          },
          disagreements: [],
        },
      ],
    },
    {
      id: "U",
      lanes: [
        {
          wave: "U",
          lane: "u1",
          reported: { stage: "merge", event: "settled", ts: "now" },
          derived: {
            alive: false,
            pr: { number: 4, state: "merged", checks: "pass" },
          },
          disagreements: [],
        },
      ],
    },
  ],
} as WaveStatus;

// name, label, value — counts for mixedStatus above.
const EXPECTED_METRICS: ReadonlyArray<readonly [string, string, string]> = [
  ["lanes", "lanes", "5"],
  ["alive", "alive", "2"],
  ["settled", "settled", "2"],
  ["failed", "failed", "1"],
  ["running", "running", "1"],
  ["open", "PRs open", "2"],
  ["merged", "PRs merged", "2"],
  ["failing", "checks failing", "1"],
  ["waves", "waves", "2"],
];

const pageStyle = async (): Promise<string> => {
  const html = await readFile(PAGE_PATH, "utf8");
  return /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
};

type LogPayload =
  | string
  | Uint8Array
  | ((url: string) => Promise<Response> | Response);

interface LoadPageOptions {
  width?: number;
  storage?: Record<string, string>;
  mockStorageError?: boolean;
  // Lets a test flip /api/status from healthy to unreachable after the
  // page's own initial load (which must succeed, or loadPage's own
  // waitFor below never resolves) — the object is held by reference, so
  // the test can mutate `.ok` after loadPage returns.
  statusGate?: { ok: boolean };
  // Lets a test take full control of what each /api/status call receives,
  // by call index (1-based) — the first call still has to feed loadPage's
  // own waitFor below (a Promise that never resolves would hang the load),
  // so a responder that wants to race a later poll should resolve call 1
  // immediately and only defer from call 2 on.
  statusResponder?: (callIndex: number) => Promise<Response> | Response;
  tokensCss?: string | false;
}

async function loadPage(
  status: WaveStatus,
  logText: LogPayload = "log-tail",
  options?: LoadPageOptions,
): Promise<PageHandle> {
  const html = await readFile(PAGE_PATH, "utf8");
  const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (scriptMatch === null) throw new Error("page has no script");

  const window = new Window({
    url: "http://127.0.0.1/",
    width: options?.width,
  });
  windows.push(window);

  if (options?.storage) {
    for (const [key, value] of Object.entries(options.storage)) {
      window.localStorage.setItem(key, value);
    }
  }
  if (options?.mockStorageError) {
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("localStorage read failed");
    });
  }

  window.document.write(html.replace(/<script>[\s\S]*?<\/script>/, ""));

  const tokensCss =
    options?.tokensCss !== undefined
      ? options.tokensCss
      : await (async () => {
          const raw = await readFile(realTokensPath, "utf8");
          const root = extractRootBlock(raw) ?? "";
          const dark = extractDarkBlock(raw) ?? "";
          return `${root}\n\n${dark}\n`;
        })();

  if (tokensCss) {
    const style = window.document.createElement("style");
    style.setAttribute("data-tokens", "");
    style.textContent = tokensCss;
    window.document.head.appendChild(style);
  }

  const fetches: string[] = [];
  let statusCalls = 0;
  const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    fetches.push(url);
    if (url.startsWith("/api/status")) {
      statusCalls++;
      if (options?.statusResponder) {
        return options.statusResponder(statusCalls);
      }
      // The very first call feeds loadPage's own waitFor below — it must
      // succeed regardless of the gate, or the page never finishes loading.
      if (options?.statusGate && statusCalls > 1 && !options.statusGate.ok) {
        throw new Error("status fetch failed");
      }
      return new Response(JSON.stringify(status), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith("/api/log/")) {
      if (typeof logText === "function") {
        const res = await logText(url);
        return res instanceof Response
          ? res
          : new Response(res, {
              status: 200,
              headers: { "content-type": "text/plain" },
            });
      }
      return new Response(logText as unknown as BodyInit, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }
    return new Response("not found", { status: 404 });
  };

  const intervals = new Set<number>();
  let lastIntervalHandler: (() => void) | null = null;
  let nextId = 1;
  const setIntervalImpl = (handler: () => void): number => {
    const id = nextId++;
    intervals.add(id);
    lastIntervalHandler = handler;
    return id;
  };
  const clearIntervalImpl = (id: number): void => {
    intervals.delete(id);
  };
  const firePoll = (): void => {
    lastIntervalHandler?.();
  };

  const run = new Function(
    "document",
    "fetch",
    "EventSource",
    "setInterval",
    "clearInterval",
    "window",
    "getComputedStyle",
    scriptMatch[1],
  ) as (
    document: Document,
    fetch: typeof globalThis.fetch,
    EventSource: typeof FakeEventSource,
    setIntervalFn: (handler: () => void, ms?: number) => number,
    clearIntervalFn: (id: number) => void,
    window: Window,
    getComputedStyle: typeof window.getComputedStyle,
  ) => void;

  run(
    window.document as unknown as Document,
    fetchImpl,
    FakeEventSource,
    setIntervalImpl,
    clearIntervalImpl,
    window,
    window.getComputedStyle.bind(window),
  );

  await vi.waitFor(() => {
    expect(window.document.querySelector("tr.lane")).not.toBeNull();
  });

  const source = FakeEventSource.instances[0];
  if (source === undefined) throw new Error("EventSource was not constructed");

  return { window, fetches, intervals, source, firePoll };
}

// happy-dom implements no activation behaviour for <button>: a real browser
// fires a click when Enter or Space is pressed on a focused button, but the
// test DOM does not, so simulate what the browser would do rather than add
// that translation to the page itself (the page relies on the real thing).
// Untyped, like the rest of this file's `as unknown as HTMLElement` casts:
// happy-dom's own DOM types are not structurally assignable to lib.dom's —
// this only ever runs against elements returned from `page.window.document`.
function press(target: unknown, key: string): void {
  const el = target as unknown as {
    ownerDocument: { defaultView: unknown } | null;
    dispatchEvent(event: unknown): boolean;
    click(): void;
  };
  const event = new (
    el.ownerDocument!.defaultView as unknown as {
      KeyboardEvent: typeof KeyboardEvent;
    }
  ).KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  if (el.dispatchEvent(event)) {
    el.click();
  }
}

describe("the status page", () => {
  test("Enter or Space on a lane row's button fetches the log", async () => {
    const page = await loadPage(statusAt());
    const row = page.window.document.querySelector("tr.lane");
    expect(row).not.toBeNull();
    expect(row?.getAttribute("role")).not.toBe("button");
    const button = row?.querySelector("button") ?? null;
    expect(button).not.toBeNull();
    expect(button?.tagName).toBe("BUTTON");
    expect(button?.textContent?.trim().length).toBeGreaterThan(0);

    const logUrl = "/api/log/T/t1?tail=16";
    press(button!, "Enter");
    const logView = page.window.document.getElementById(
      "log",
    ) as HTMLElement | null;
    await vi.waitFor(() => {
      expect(page.fetches).toContain(logUrl);
      expect(logView?.hidden).toBe(false);
      expect(logView?.textContent).toContain("log-tail");
    });
    // A deleted hand-rolled keydown handler and native <button> activation
    // both answering the same key press is exactly the double-fire a real
    // browser would never produce: one key press, one fetch.
    expect(page.fetches.filter((url) => url === logUrl)).toHaveLength(1);

    page.fetches.length = 0;
    if (logView !== null) logView.textContent = "";
    press(button!, " ");
    await vi.waitFor(() => {
      expect(page.fetches).toContain(logUrl);
      expect(logView?.textContent).toContain("log-tail");
    });
    expect(page.fetches.filter((url) => url === logUrl)).toHaveLength(1);
  });

  test("a click anywhere on a lane row still opens the log", async () => {
    const page = await loadPage(statusAt());
    const row = page.window.document.querySelector(
      "tr.lane",
    ) as unknown as HTMLElement | null;
    expect(row).not.toBeNull();
    row?.click();
    await vi.waitFor(() => {
      expect(page.fetches).toContain("/api/log/T/t1?tail=16");
    });
  });

  test("every wave and lane button carries a non-empty accessible name", async () => {
    const page = await loadPage(mixedStatus);
    const doc = page.window.document;
    const waveButtons = doc.querySelectorAll("tr.wave button");
    const laneButtons = doc.querySelectorAll("tr.lane button");
    expect(waveButtons.length).toBe(2);
    expect(laneButtons.length).toBe(5);
    for (const button of [...waveButtons, ...laneButtons]) {
      expect(button.tagName).toBe("BUTTON");
      expect(button.textContent?.trim().length).toBeGreaterThan(0);
    }
  });

  test('no <tr> carries role="button", and the page never wires its own keydown handling for it', async () => {
    const page = await loadPage(mixedStatus);
    const doc = page.window.document;
    for (const row of doc.querySelectorAll("tr")) {
      expect(row.getAttribute("role")).not.toBe("button");
    }
    const html = await readFile(PAGE_PATH, "utf8");
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
    expect(script).not.toMatch(/addEventListener\(\s*["']keydown["']/);
  });

  test("a second SSE drop does not stack polling intervals", async () => {
    const page = await loadPage(statusAt());
    page.source.onerror?.();
    page.source.onerror?.();
    expect(page.intervals.size).toBe(1);
  });

  test("a detail value of <b> renders as text, not markup", async () => {
    const page = await loadPage(
      statusAt({
        fixed: "<b>",
        refuted: "<img>",
        mutations: "</td>",
        mutationsBit: "<i>",
      }),
    );
    const cell = page.window.document.querySelector("tr.lane td:last-child");
    expect(cell?.textContent).toContain("<b>");
    expect(cell?.textContent).toContain("<img>");
    expect(cell?.textContent).toContain("</td>");
    expect(cell?.textContent).toContain("<i>");
    expect(cell?.innerHTML).toContain("&lt;b&gt;");
    expect(cell?.innerHTML).toContain("&lt;img&gt;");
    expect(cell?.innerHTML).toContain("&lt;/td&gt;");
    expect(cell?.innerHTML).toContain("&lt;i&gt;");
    expect(cell?.querySelector("b")).toBeNull();
    expect(cell?.querySelector("img")).toBeNull();
    expect(cell?.querySelector("i")).toBeNull();
  });

  test("the metrics strip renders each metric with its label", async () => {
    const page = await loadPage(mixedStatus);
    const doc = page.window.document;
    for (const [name, label, value] of EXPECTED_METRICS) {
      const metric = doc.querySelector(`[data-metric="${name}"]`);
      expect(metric?.querySelector(".value")?.textContent).toBe(value);
      expect(metric?.querySelector(".label")?.textContent).toBe(label);
    }
    // PR metrics come from observed PRs, not from lanes: five lanes (one with
    // no PR at all) yield PRs open 2 — a count fed by lanes instead of PR
    // observations would read 5, or sweep the no-PR lane into some bucket.
    expect(doc.querySelector('[data-metric="open"] .value')?.textContent).toBe(
      "2",
    );
    expect(
      doc.querySelector('[data-metric="merged"] .value')?.textContent,
    ).toBe("2");
    expect(doc.querySelector('[data-metric="lanes"] .value')?.textContent).toBe(
      "5",
    );
    // A problem count only turns red when there is a problem — mixedStatus
    // has one failed lane and one failing check, so those two values (and
    // only those two) carry the hot class.
    expect(
      doc.querySelector('[data-metric="failed"] .value')?.classList.contains(
        "hot",
      ),
    ).toBe(true);
    expect(
      doc.querySelector('[data-metric="failing"] .value')?.classList.contains(
        "hot",
      ),
    ).toBe(true);
    expect(
      doc.querySelector('[data-metric="settled"] .value')?.classList.contains(
        "hot",
      ),
    ).toBe(false);
  });

  test("an unknown metric renders —, never 0", async () => {
    // statusAt(): one lane, no reported events, no PR — nothing is known
    // about outcomes or PRs, and the header must say so.
    const page = await loadPage(statusAt());
    const doc = page.window.document;
    for (const name of [
      "settled",
      "failed",
      "running",
      "open",
      "merged",
      "failing",
    ]) {
      expect(
        doc.querySelector(`[data-metric="${name}"] .value`)?.textContent,
      ).toBe("—");
    }
    // The structural counts are known the moment a status arrives; a known
    // zero (all lanes not alive) is a real answer, unlike an unknown one.
    expect(doc.querySelector('[data-metric="lanes"] .value')?.textContent).toBe(
      "1",
    );
    expect(doc.querySelector('[data-metric="alive"] .value')?.textContent).toBe(
      "0",
    );
    expect(doc.querySelector('[data-metric="waves"] .value')?.textContent).toBe(
      "1",
    );
  });

  test("the container declares two grid rows and the log pane is hidden with no log open", async () => {
    const page = await loadPage(statusAt());
    const html = await readFile(PAGE_PATH, "utf8");
    const style = await pageStyle();
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
    // Two rows with no log open, three with one — the grid sizes both panes;
    // JavaScript only flips the state, it must never listen for resizes.
    expect(style).toMatch(/#page\s*\{[^}]*grid-template-rows:\s*auto 1fr\s*;/);
    expect(style).toMatch(
      /#page\.with-log\s*\{[^}]*grid-template-rows:\s*auto 1fr 1fr\s*;/,
    );
    expect(style).not.toMatch(/max-height:\s*40vh/);
    expect(script).not.toMatch(
      /addEventListener\(\s*["']resize["']|onresize\s*=/,
    );
    const logView = page.window.document.getElementById(
      "log",
    ) as HTMLElement | null;
    expect(logView?.hidden).toBe(true);
  });

  test("opening a log reveals the second row; closing it returns the table to full height", async () => {
    const page = await loadPage(statusAt());
    const doc = page.window.document;
    const container = doc.getElementById("page");
    const logPane = doc.getElementById("log-pane") as HTMLElement | null;
    const logView = doc.getElementById("log") as HTMLElement | null;
    expect(container?.classList.contains("with-log")).toBe(false);
    expect(logPane?.hidden).toBe(true);
    expect(logView?.hidden).toBe(true);

    const row = doc.querySelector("tr.lane");
    press(row!.querySelector("button")!, "Enter");
    await vi.waitFor(() => {
      expect(page.fetches).toContain("/api/log/T/t1?tail=16");
      expect(logPane?.hidden).toBe(false);
      expect(logView?.hidden).toBe(false);
      expect(container?.classList.contains("with-log")).toBe(true);
    });

    const closeBtn = doc.querySelector(
      'button[aria-label="close"]',
    ) as unknown as HTMLElement | null;
    closeBtn?.click();
    expect(logPane?.hidden).toBe(true);
    expect(logView?.hidden).toBe(true);
    expect(container?.classList.contains("with-log")).toBe(false);
  });

  test("the pane shows a visible focus treatment when focused", async () => {
    const page = await loadPage(statusAt(), "log-tail");
    const doc = page.window.document;
    const row = doc.querySelector("tr.lane");
    const logPane = doc.getElementById("log-pane");

    expect(doc.activeElement).not.toBe(logPane);
    expect(page.window.getComputedStyle(logPane!).outlineStyle).not.toBe("solid");

    press(row!.querySelector("button")!, "Enter");
    await vi.waitFor(() => {
      expect(doc.activeElement).toBe(logPane);
    });

    const style = page.window.getComputedStyle(logPane!);
    expect(style.outlineStyle).toBe("solid");
    expect(style.outlineWidth).toBe("2px");
  });

  test("the toolbar renders each control with an accessible name, and the lane name and byte size", async () => {
    const page = await loadPage(statusAt(), "log-tail");
    const doc = page.window.document;
    const row = doc.querySelector("tr.lane");
    press(row!.querySelector("button")!, "Enter");
    // The pane itself is revealed synchronously, before the log tail fetch
    // resolves (the active lane's identity settles before the request
    // starts) — wait for the fetched size instead, which only appears once
    // the response has landed.
    await vi.waitFor(() => {
      expect(doc.getElementById("log-size")?.textContent?.trim()).toBe("8 B");
    });

    const toolbar = doc.getElementById("log-toolbar");
    expect(toolbar).not.toBeNull();
    expect(doc.getElementById("log-lane")?.textContent?.trim()).toBe("T/t1");

    const expandBtn = toolbar?.querySelector('button[aria-label="expand"]');
    const copyBtn = toolbar?.querySelector('button[aria-label="copy"]');
    const downloadBtn = toolbar?.querySelector('button[aria-label="download"]');
    const closeBtn = toolbar?.querySelector('button[aria-label="close"]');

    expect(expandBtn).not.toBeNull();
    expect(expandBtn?.textContent?.trim()).toBe("expand");
    expect(copyBtn).not.toBeNull();
    expect(copyBtn?.textContent?.trim()).toBe("copy");
    expect(downloadBtn).not.toBeNull();
    expect(downloadBtn?.textContent?.trim()).toBe("download");
    expect(closeBtn).not.toBeNull();
    expect(closeBtn?.textContent?.trim()).toBe("close");
  });

  test("expand sets the table row to zero and collapse restores it; the toggle's label changes", async () => {
    const page = await loadPage(statusAt());
    const doc = page.window.document;
    const container = doc.getElementById("page");
    const row = doc.querySelector("tr.lane");
    press(row!.querySelector("button")!, "Enter");
    await vi.waitFor(() => {
      expect(container?.classList.contains("with-log")).toBe(true);
    });

    const expandBtn = doc.querySelector(
      'button[aria-label="expand"]',
    ) as unknown as HTMLElement;
    expect(expandBtn.textContent?.trim()).toBe("expand");
    expect(page.window.getComputedStyle(container!).gridTemplateRows).toBe(
      "auto 1fr 1fr",
    );

    expandBtn.click();
    expect(container?.classList.contains("expanded")).toBe(true);
    expect(expandBtn.textContent?.trim()).toBe("collapse");
    expect(expandBtn.getAttribute("aria-label")).toBe("collapse");
    expect(page.window.getComputedStyle(container!).gridTemplateRows).toBe(
      "auto 0 1fr",
    );

    expandBtn.click();
    expect(container?.classList.contains("expanded")).toBe(false);
    expect(expandBtn.textContent?.trim()).toBe("expand");
    expect(expandBtn.getAttribute("aria-label")).toBe("expand");
    expect(page.window.getComputedStyle(container!).gridTemplateRows).toBe(
      "auto 1fr 1fr",
    );
  });

  test("the expand icon reflects aria-expanded in both states", async () => {
    // getComputedStyle resolves class-driven and attribute-driven declarations
    // in this suite (§8 Testing the UI) because public/index.html includes its
    // <style> block — assert the computed transform rotates when expanded.
    const page = await loadPage(statusAt());
    const doc = page.window.document;
    const row = doc.querySelector("tr.lane");
    press(row!.querySelector("button")!, "Enter");
    await vi.waitFor(() => {
      expect(
        (doc.getElementById("log-pane") as HTMLElement | null)?.hidden,
      ).toBe(false);
    });

    const expandBtn = doc.querySelector(
      'button[aria-label="expand"]',
    ) as unknown as HTMLElement;
    const icon = doc.querySelector("#log-expand svg");

    expect(expandBtn.getAttribute("aria-expanded")).toBe("false");
    expect(expandBtn.getAttribute("aria-controls")).toBe("log-pane");
    expect(page.window.getComputedStyle(icon!).transform).not.toBe(
      "rotate(180deg)",
    );

    expandBtn.click();
    expect(expandBtn.getAttribute("aria-expanded")).toBe("true");
    expect(expandBtn.getAttribute("aria-label")).toBe("collapse");
    expect(page.window.getComputedStyle(icon!).transform).toBe(
      "rotate(180deg)",
    );

    expandBtn.click();
    expect(expandBtn.getAttribute("aria-expanded")).toBe("false");
    expect(expandBtn.getAttribute("aria-label")).toBe("expand");
    expect(page.window.getComputedStyle(icon!).transform).not.toBe(
      "rotate(180deg)",
    );
  });

  test("copy writes the body text without line numbers — assert the clipboard payload", async () => {
    const multiline = "first line\nsecond line\nthird line";
    const page = await loadPage(statusAt(), multiline);
    const doc = page.window.document;
    const row = doc.querySelector("tr.lane");
    press(row!.querySelector("button")!, "Enter");
    // Wait for the body itself, not just the pane's visibility — the pane
    // is revealed before the log tail fetch resolves.
    await vi.waitFor(() => {
      expect(doc.querySelectorAll(".line").length).toBeGreaterThan(0);
    });

    const copyBtn = doc.querySelector(
      'button[aria-label="copy"]',
    ) as unknown as HTMLElement;
    copyBtn.click();
    await vi.waitFor(async () => {
      const text = await page.window.navigator.clipboard.readText();
      expect(text).toBe(multiline);
    });
  });

  test("the copy feedback states render and clear", async () => {
    const page = await loadPage(statusAt(), "one line");
    const doc = page.window.document;
    const row = doc.querySelector("tr.lane");
    press(row!.querySelector("button")!, "Enter");
    await vi.waitFor(() => {
      expect(doc.querySelectorAll(".line").length).toBeGreaterThan(0);
    });

    const copyBtn = doc.querySelector(
      'button[aria-label="copy"]',
    ) as unknown as HTMLElement;

    vi.useFakeTimers();
    try {
      copyBtn.click();
      await vi.waitFor(() => {
        expect(copyBtn.textContent?.trim()).toBe("copied");
      });
      expect(copyBtn.classList.contains("ok")).toBe(true);
      expect(copyBtn.classList.contains("bad")).toBe(false);

      vi.advanceTimersByTime(1600);
      expect(copyBtn.textContent?.trim()).toBe("copy");
      expect(copyBtn.classList.contains("ok")).toBe(false);
      expect(copyBtn.classList.contains("bad")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test("the gutter is user-select: none, and the number of gutter entries equals the line count", async () => {
    const multiline = "alpha\nbeta\ngamma\ndelta";
    const lineCount = 4;
    const page = await loadPage(statusAt(), multiline);
    const doc = page.window.document;
    const row = doc.querySelector("tr.lane");
    press(row!.querySelector("button")!, "Enter");
    // Wait for the fetched body, not just the pane's visibility — the pane
    // is revealed before the log tail fetch resolves.
    await vi.waitFor(() => {
      expect(doc.querySelectorAll(".gutter").length).toBe(lineCount);
    });

    const gutters = doc.querySelectorAll(".gutter");
    expect(gutters.length).toBe(lineCount);
    for (const gutter of gutters) {
      expect(page.window.getComputedStyle(gutter).userSelect).toBe("none");
    }
  });

  test("the page still declares no --color-* custom property of its own", async () => {
    const style = await pageStyle();
    expect(style).toMatch(/var\(--color-/); // tokens are consumed, from /tokens.css
    expect(style).not.toMatch(/--color-[\w-]+\s*:/);
  });

  test("the connection indicator reflects each state it can be in, driven by the real connection", async () => {
    const statusGate = { ok: true };
    const page = await loadPage(statusAt(), undefined, { statusGate });
    const doc = page.window.document;
    const indicator = doc.getElementById("connection") as HTMLElement | null;
    expect(indicator).not.toBeNull();

    // Before any SSE event fires, the page is still connecting — nothing
    // has pinned it to a class of its own; this is the markup's own initial
    // state, still standing.
    expect(indicator?.className).toBe("connecting");
    expect(indicator?.textContent).toMatch(/connecting/);

    // The stream opens: live.
    page.source.onopen?.();
    expect(indicator?.className).toBe("live");
    expect(indicator?.textContent).toMatch(/live/);

    // An SSE status event also (re-)confirms live.
    page.source.emit("status", JSON.stringify(statusAt()));
    expect(indicator?.className).toBe("live");

    // The stream drops but the status endpoint still answers: polling, not
    // down — connectivity to the server itself is still fine.
    page.source.onerror?.();
    expect(indicator?.className).toBe("polling");
    expect(indicator?.textContent).toMatch(/polling/);

    // Now the status endpoint itself stops answering: a poll tick (fired
    // here directly, the way the real 10 s timer would) that fails must
    // flip the indicator to down — this is the real fallback failing, not
    // a class hardcoded on the element. The onerror handler above already
    // started a refresh() that is still in flight (gate was true when it
    // read it) — the sequence guard in refresh() must stop that stale,
    // eventually-successful call from clobbering this one back to
    // "polling" once it lands after this one already reported down.
    statusGate.ok = false;
    page.firePoll();
    await vi.waitFor(() => {
      expect(indicator?.className).toBe("down");
    });
    expect(indicator?.textContent).toMatch(/unreachable/);

    // Connectivity returns: the next poll tick itself (not the SSE drop
    // handler, which would set "polling" regardless of the fetch outcome)
    // must climb the indicator back out of "down" on its own.
    statusGate.ok = true;
    page.firePoll();
    await vi.waitFor(() => {
      expect(indicator?.className).toBe("polling");
    });
  });

  test("an SSE status arriving while a poll is pending wins — the late poll changes neither the table nor the indicator", async () => {
    const sseStatus = statusAt({ fixed: "from-sse" });
    const stalePollStatus = statusAt({ fixed: "from-stale-poll" });

    let resolveSlowPoll!: (res: Response) => void;
    const pendingPoll = new Promise<Response>((resolve) => {
      resolveSlowPoll = resolve;
    });

    const page = await loadPage(statusAt(), undefined, {
      statusResponder: (callIndex) => {
        // Call 1 is the page's own initial load — it must resolve so
        // loadPage's waitFor below is not left hanging on a Promise that
        // never settles. Every call after that (the onerror-triggered
        // poll below) hangs on `pendingPoll` until the test resolves it.
        if (callIndex === 1) {
          return new Response(JSON.stringify(statusAt()), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return pendingPoll;
      },
    });
    const doc = page.window.document;
    const indicator = doc.getElementById("connection") as HTMLElement | null;
    const findings = () =>
      doc.querySelector("tr.lane td:last-child")?.textContent ?? "";

    // The stream drops, which starts a fallback poll (call 2) — it is
    // now in flight, awaiting `pendingPoll`.
    page.source.onerror?.();
    expect(indicator?.className).toBe("polling");

    // SSE reconnects and delivers a status event while that poll is still
    // pending. Its data must land, and the indicator must say live.
    page.source.emit("status", JSON.stringify(sseStatus));
    expect(findings()).toContain("from-sse");
    expect(indicator?.className).toBe("live");

    // The stale poll finally resolves, with different content. It must
    // change nothing: the table still shows the SSE payload, not the
    // poll's, and the indicator is untouched.
    resolveSlowPoll(
      new Response(JSON.stringify(stalePollStatus), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(findings()).toContain("from-sse");
    expect(findings()).not.toContain("from-stale-poll");
    expect(indicator?.className).toBe("live");
  });

  test("a poll that fails while the stream is healthy leaves the indicator live, not down", async () => {
    let settlePendingPoll!: (res: Response | Promise<Response>) => void;
    const pendingPoll = new Promise<Response>((resolve) => {
      settlePendingPoll = resolve;
    });

    const page = await loadPage(statusAt(), undefined, {
      statusResponder: (callIndex) => {
        // Same shape as above: call 1 feeds loadPage's own load, every
        // call after that hangs until the test settles it.
        if (callIndex === 1) {
          return new Response(JSON.stringify(statusAt()), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return pendingPoll;
      },
    });
    const doc = page.window.document;
    const indicator = doc.getElementById("connection") as HTMLElement | null;

    // The stream drops, starting a fallback poll (call 2) — in flight,
    // awaiting `pendingPoll`.
    page.source.onerror?.();
    expect(indicator?.className).toBe("polling");

    // The stream comes back up while that poll is still pending — a
    // reconnect the real EventSource fires as another `onopen`.
    page.source.onopen?.();
    expect(indicator?.className).toBe("live");

    // The stale poll now fails. The connection is healthy — this must not
    // be read as "the connection is down".
    settlePendingPoll(Promise.reject(new Error("status fetch failed")));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(indicator?.className).toBe("live");
    expect(indicator?.textContent).toMatch(/live/);
  });

  test("a late log response does not overwrite a newer opened lane's header, size, or body", async () => {
    const twoLanesStatus: WaveStatus = {
      generatedAt: "now",
      waves: [
        {
          id: "T",
          lanes: [
            {
              wave: "T",
              lane: "t1",
              derived: { alive: true },
              disagreements: [],
            },
            {
              wave: "T",
              lane: "t2",
              derived: { alive: true },
              disagreements: [],
            },
          ],
        },
      ],
    } as WaveStatus;

    let resolveT1!: (res: Response) => void;
    const pT1 = new Promise<Response>((resolve) => {
      resolveT1 = resolve;
    });

    let resolveT2!: (res: Response) => void;
    const pT2 = new Promise<Response>((resolve) => {
      resolveT2 = resolve;
    });

    const page = await loadPage(twoLanesStatus, (url) => {
      if (url.includes("/api/log/T/t1")) return pT1;
      if (url.includes("/api/log/T/t2")) return pT2;
      return new Response("not found", { status: 404 });
    });

    const doc = page.window.document;
    const rows = doc.querySelectorAll("tr.lane");
    expect(rows.length).toBe(2);

    // 1. Start opening lane T/t1 (pending)
    press(rows[0]!.querySelector("button")!, "Enter");

    // 2. Start opening lane T/t2 before T/t1 resolves
    press(rows[1]!.querySelector("button")!, "Enter");

    // 3. Resolve the second lane (T/t2) first
    resolveT2(new Response("log for t2", { status: 200 }));

    await vi.waitFor(() => {
      expect(doc.getElementById("log-lane")?.textContent).toBe("T/t2");
      expect(doc.getElementById("log-size")?.textContent).toBe("10 B");
      expect(doc.getElementById("log")?.textContent).toContain("log for t2");
    });

    // 4. Now let the first lane (T/t1) resolve later
    resolveT1(new Response("stale log for t1", { status: 200 }));

    // Give any asynchronous late handling an opportunity to misfire
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Assert header, size and body all remain belonging to the second lane
    expect(doc.getElementById("log-lane")?.textContent).toBe("T/t2");
    expect(doc.getElementById("log-size")?.textContent).toBe("10 B");
    expect(doc.getElementById("log")?.textContent).toContain("log for t2");
    expect(doc.getElementById("log")?.textContent).not.toContain(
      "stale log for t1",
    );
  });

  test("a log that resolves after a newer open does not move focus", async () => {
    const twoLanesStatus: WaveStatus = {
      generatedAt: "now",
      waves: [
        {
          id: "T",
          lanes: [
            {
              wave: "T",
              lane: "t1",
              derived: { alive: true },
              disagreements: [],
            },
            {
              wave: "T",
              lane: "t2",
              derived: { alive: true },
              disagreements: [],
            },
          ],
        },
      ],
    } as WaveStatus;

    let resolveT1!: (res: Response) => void;
    const pT1 = new Promise<Response>((resolve) => {
      resolveT1 = resolve;
    });

    let resolveT2!: (res: Response) => void;
    const pT2 = new Promise<Response>((resolve) => {
      resolveT2 = resolve;
    });

    const page = await loadPage(twoLanesStatus, (url) => {
      if (url.includes("/api/log/T/t1")) return pT1;
      if (url.includes("/api/log/T/t2")) return pT2;
      return new Response("not found", { status: 404 });
    });

    const doc = page.window.document;
    const rows = doc.querySelectorAll("tr.lane");
    const logPane = doc.getElementById("log-pane");
    const row0Btn = rows[0]!.querySelector("button")!;
    const row1Btn = rows[1]!.querySelector("button")!;

    // 1. Start opening lane T/t1 (pending)
    press(row0Btn, "Enter");

    // 2. Start opening lane T/t2 before T/t1 resolves
    press(row1Btn, "Enter");
    row1Btn.focus();
    expect(doc.activeElement).toBe(row1Btn);

    // 3. Stale T/t1 resolves while T/t2 is still pending
    resolveT1(new Response("stale log for t1", { status: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Stale resolution must NOT move focus to the pane
    expect(doc.activeElement).toBe(row1Btn);
    expect(doc.activeElement).not.toBe(logPane);

    // 4. Newer T/t2 resolves — it is newest, so it moves focus to the pane
    resolveT2(new Response("log for t2", { status: 200 }));
    await vi.waitFor(() => {
      expect(doc.activeElement).toBe(logPane);
    });
  });

  test("a lane switch with a render in between: the header, the size and the body all name the new lane", async () => {
    const twoLanesStatus: WaveStatus = {
      generatedAt: "now",
      waves: [
        {
          id: "T",
          lanes: [
            {
              wave: "T",
              lane: "t1",
              derived: { alive: true },
              disagreements: [],
            },
            {
              wave: "T",
              lane: "t2",
              derived: { alive: true },
              disagreements: [],
            },
          ],
        },
      ],
    } as WaveStatus;

    let resolveT1Open!: (res: Response) => void;
    const pT1Open = new Promise<Response>((resolve) => {
      resolveT1Open = resolve;
    });
    let resolveT1Follow!: (res: Response) => void;
    const pT1Follow = new Promise<Response>((resolve) => {
      resolveT1Follow = resolve;
    });
    let resolveT2Open!: (res: Response) => void;
    const pT2Open = new Promise<Response>((resolve) => {
      resolveT2Open = resolve;
    });

    let t1Calls = 0;
    const page = await loadPage(twoLanesStatus, (url) => {
      if (url.includes("/api/log/T/t1")) {
        t1Calls++;
        return t1Calls === 1 ? pT1Open : pT1Follow;
      }
      if (url.includes("/api/log/T/t2")) return pT2Open;
      return new Response("not found", { status: 404 });
    });

    const doc = page.window.document;
    const rows = doc.querySelectorAll("tr.lane");
    expect(rows.length).toBe(2);

    // 1. Open lane t1 and turn follow on for it.
    press(rows[0]!.querySelector("button")!, "Enter");
    resolveT1Open(new Response("t1 initial", { status: 200 }));
    await vi.waitFor(() => {
      const checkbox = doc.getElementById("log-follow");
      expect(checkbox).not.toBeNull();
    });
    const followCheckbox = doc.getElementById(
      "log-follow",
    ) as unknown as HTMLInputElement;
    followCheckbox.checked = true;
    const changeEvent = new (
      followCheckbox.ownerDocument!.defaultView as unknown as {
        Event: typeof Event;
      }
    ).Event("change", { bubbles: true });
    followCheckbox.dispatchEvent(changeEvent);
    // The change listener above started a follow refresh for t1 — it is
    // now in flight, awaiting pT1Follow.

    // 2. Switch to t2 while that follow refresh for t1 is still pending.
    press(rows[1]!.querySelector("button")!, "Enter");

    // 3. A status render lands mid-switch — the follow path's other
    // trigger — before either pending fetch resolves.
    page.source.emit("status", JSON.stringify(twoLanesStatus));

    // 4. The stale t1 follow refresh resolves. It must never reach the
    // screen: t2 is the active lane now.
    resolveT1Follow(new Response("stale t1 follow content", { status: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    // 5. t2's own open request resolves.
    resolveT2Open(new Response("t2 content", { status: 200 }));

    await vi.waitFor(() => {
      expect(doc.getElementById("log-lane")?.textContent).toBe("T/t2");
      expect(doc.getElementById("log-size")?.textContent).toBe("10 B");
      expect(doc.getElementById("log")?.textContent).toContain("t2 content");
    });
    expect(doc.getElementById("log")?.textContent).not.toContain(
      "stale t1 follow content",
    );
  });

  test("copy reports failure and does not claim success when clipboard API is absent or writeText rejects", async () => {
    const page = await loadPage(statusAt(), "sample log");
    const doc = page.window.document;
    const row = doc.querySelector("tr.lane");
    press(row!.querySelector("button")!, "Enter");
    await vi.waitFor(() => {
      expect(
        (doc.getElementById("log-pane") as HTMLElement | null)?.hidden,
      ).toBe(false);
    });

    const copyBtn = doc.querySelector(
      'button[aria-label="copy"]',
    ) as unknown as HTMLElement;

    // A: navigator.clipboard absent
    Object.defineProperty(page.window.navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });
    copyBtn.click();
    await vi.waitFor(() => {
      expect(copyBtn.textContent?.trim()).not.toBe("copied");
      expect(copyBtn.textContent?.trim()).toBe("copy failed");
    });

    // B: writeText rejects
    Object.defineProperty(page.window.navigator, "clipboard", {
      value: {
        writeText: vi
          .fn()
          .mockRejectedValue(new Error("clipboard permission denied")),
      },
      configurable: true,
    });
    copyBtn.click();
    await vi.waitFor(() => {
      expect(copyBtn.textContent?.trim()).not.toBe("copied");
      expect(copyBtn.textContent?.trim()).toBe("copy failed");
    });
  });

  test("copy selects .line nodes directly and ignores gutter even if user-select is auto", async () => {
    const multiline = "alpha\nbeta\ngamma";
    const page = await loadPage(statusAt(), multiline);
    const doc = page.window.document;
    const row = doc.querySelector("tr.lane");
    press(row!.querySelector("button")!, "Enter");
    // Wait for the fetched body, not just the pane's visibility — the pane
    // is revealed before the log tail fetch resolves.
    await vi.waitFor(() => {
      expect(doc.querySelectorAll(".gutter").length).toBe(3);
    });

    // Gutter user-select set to auto (e.g. style change)
    const gutters = doc.querySelectorAll(".gutter");
    expect(gutters.length).toBe(3);
    for (const gutter of gutters) {
      gutter.setAttribute("style", "user-select: auto");
      expect(page.window.getComputedStyle(gutter).userSelect).toBe("auto");
    }

    const copyBtn = doc.querySelector(
      'button[aria-label="copy"]',
    ) as unknown as HTMLElement;
    copyBtn.click();

    await vi.waitFor(async () => {
      const text = await page.window.navigator.clipboard.readText();
      expect(text).toBe(multiline);
    });
  });

  test("a tail whose first bytes are a split multi-byte character reports the served byte length", async () => {
    const splitBytes = new Uint8Array([0x80, 0x61, 0x62]);
    const page = await loadPage(statusAt(), splitBytes);
    const doc = page.window.document;
    const row = doc.querySelector("tr.lane");
    press(row!.querySelector("button")!, "Enter");

    await vi.waitFor(() => {
      expect(
        (doc.getElementById("log-pane") as HTMLElement | null)?.hidden,
      ).toBe(false);
      expect(doc.getElementById("log-size")?.textContent).toBe("3 B");
    });
  });

  test("at a narrow width every toolbar control is still reachable", async () => {
    const page = await loadPage(statusAt(), "log content", { width: 320 });
    const doc = page.window.document;
    const row = doc.querySelector("tr.lane");
    press(row!.querySelector("button")!, "Enter");
    await vi.waitFor(() => {
      expect(
        (doc.getElementById("log-pane") as HTMLElement | null)?.hidden,
      ).toBe(false);
    });

    const toolbar = doc.getElementById("log-toolbar");
    expect(toolbar).not.toBeNull();
    expect(page.window.getComputedStyle(toolbar!).flexWrap).toBe("wrap");

    const expandBtn = toolbar?.querySelector('button[aria-label="expand"]');
    const copyBtn = toolbar?.querySelector('button[aria-label="copy"]');
    const downloadBtn = toolbar?.querySelector('button[aria-label="download"]');
    const closeBtn = toolbar?.querySelector('button[aria-label="close"]');

    for (const btn of [expandBtn, copyBtn, downloadBtn, closeBtn]) {
      expect(btn).not.toBeNull();
      expect((btn as unknown as HTMLElement)?.hidden).toBe(false);
      expect(page.window.getComputedStyle(btn!).display).not.toBe("none");
    }
  });

  test("every control in the toolbar resolves its border to the control token and frames keep the frame token", async () => {
    const page = await loadPage(statusAt());
    const doc = page.window.document;
    const sheet = doc.styleSheets[0];
    const style = await pageStyle();

    interface StyleRuleLike {
      readonly selectorText: string;
      readonly style: {
        readonly borderColor?: string;
        readonly borderBottomColor?: string;
        readonly border?: string;
      };
    }

    const rules = Array.from(
      sheet.cssRules,
    ) as unknown as readonly StyleRuleLike[];

    const controls = doc.querySelectorAll("#log-toolbar button");
    expect(controls.length).toBeGreaterThan(0);

    for (const control of controls) {
      const rule = rules.find(
        (r) =>
          r.selectorText !== undefined &&
          !r.selectorText.includes(":") &&
          control.matches(r.selectorText) &&
          Boolean(r.style.borderColor || r.style.border),
      );
      expect(rule?.style.borderColor).toBe("var(--color-border-control)");
    }

    const hoverRule = rules.find(
      (r) => r.selectorText === "#log-toolbar button:hover",
    );
    expect(hoverRule?.style.borderColor).toBe(
      "var(--color-border-control-hover)",
    );

    // At least one frame still resolves to the frame token
    const frame = doc.getElementById("log-pane");
    expect(frame).not.toBeNull();
    const frameRule = rules.find(
      (r) =>
        r.selectorText !== undefined &&
        !r.selectorText.includes(":") &&
        frame!.matches(r.selectorText) &&
        Boolean(r.style.borderColor || r.style.border),
    );
    expect(frameRule?.style.borderColor).toBe("var(--color-border)");

    expect(style).toMatch(
      /#log-toolbar button\s*\{[^}]*border:\s*1px solid var\(--color-border-control\)/,
    );
    expect(style).toMatch(
      /#log-toolbar button:hover\s*\{[^}]*border-color:\s*var\(--color-border-control-hover\)/,
    );
  });

  test("pressing download targets the current lane's full=1 URL, performs no fetch, and names the same lane in the download attribute", async () => {
    const page = await loadPage(mixedStatus);
    const doc = page.window.document;
    const rows = doc.querySelectorAll("tr.lane");
    expect(rows.length).toBeGreaterThanOrEqual(2);

    const downloads: Array<{ href: string; download: string }> = [];
    const origCreateElement = doc.createElement.bind(doc);
    vi.spyOn(doc, "createElement").mockImplementation(
      (tagName: string, ...args) => {
        const el = origCreateElement(tagName, ...args);
        if (tagName.toLowerCase() === "a") {
          vi.spyOn(el, "click").mockImplementation(() => {
            downloads.push({
              href:
                el.getAttribute("href") ??
                (el as unknown as { href: string }).href,
              download:
                el.getAttribute("download") ??
                (el as unknown as { download: string }).download,
            });
          });
        }
        return el;
      },
    );

    // Open first lane: T/t1
    press(rows[0]!.querySelector("button")!, "Enter");
    await vi.waitFor(() => {
      expect(
        (doc.getElementById("log-pane") as HTMLElement | null)?.hidden,
      ).toBe(false);
      expect(doc.getElementById("log-lane")?.textContent).toBe("T/t1");
    });

    const downloadBtn = doc.querySelector(
      'button[aria-label="download"]',
    ) as HTMLElement | null;
    expect(downloadBtn).not.toBeNull();

    const fetchesAfterLane1 = page.fetches.length;
    downloadBtn?.click();

    expect(downloads).toEqual([
      { href: "/api/log/T/t1?full=1", download: "T-t1.log" },
    ]);
    expect(page.fetches.length).toBe(fetchesAfterLane1);
    expect(page.fetches.filter((url) => url.includes("full=1"))).toHaveLength(
      0,
    );

    // Switch to second lane: T/t2
    press(rows[1]!.querySelector("button")!, "Enter");
    await vi.waitFor(() => {
      expect(doc.getElementById("log-lane")?.textContent).toBe("T/t2");
    });

    const fetchesAfterLane2 = page.fetches.length;
    downloadBtn?.click();

    expect(downloads).toEqual([
      { href: "/api/log/T/t1?full=1", download: "T-t1.log" },
      { href: "/api/log/T/t2?full=1", download: "T-t2.log" },
    ]);
    expect(page.fetches.length).toBe(fetchesAfterLane2);
    expect(page.fetches.filter((url) => url.includes("full=1"))).toHaveLength(
      0,
    );
  });

  test("every wave renders collapsed, and its lanes are not present or not visible until it is opened", async () => {
    const page = await loadPage(mixedStatus);
    const doc = page.window.document;
    const waveRows = doc.querySelectorAll("tr.wave");
    expect(waveRows.length).toBe(2);

    for (const waveRow of waveRows) {
      expect(
        waveRow.querySelector("button")?.getAttribute("aria-expanded"),
      ).toBe("false");
    }

    const laneRows = doc.querySelectorAll("tr.lane");
    expect(laneRows.length).toBe(5);
    for (const laneRow of laneRows) {
      expect((laneRow as unknown as HTMLElement).hidden).toBe(true);
    }
  });

  test("opening a wave reveals its lanes and their disagreement rows; closing hides both", async () => {
    const statusWithDisagreement: WaveStatus = {
      generatedAt: "now",
      waves: [
        {
          id: "W",
          lanes: [
            {
              wave: "W",
              lane: "w1",
              derived: { alive: true },
              disagreements: ["lane disagreement banner"],
            },
            {
              wave: "W",
              lane: "w2",
              derived: { alive: false },
              disagreements: [],
            },
          ],
        },
      ],
    } as WaveStatus;

    const page = await loadPage(statusWithDisagreement);
    const doc = page.window.document;
    const waveRow = doc.querySelector("tr.wave") as unknown as HTMLElement;
    const laneRows = doc.querySelectorAll("tr.lane");
    const disagreementRows = doc.querySelectorAll("tr.disagreement");
    expect(laneRows.length).toBe(2);
    expect(disagreementRows.length).toBe(1);

    // Initially collapsed
    expect((laneRows[0] as unknown as HTMLElement | undefined)?.hidden).toBe(
      true,
    );
    expect((laneRows[1] as unknown as HTMLElement | undefined)?.hidden).toBe(
      true,
    );
    expect(
      (disagreementRows[0] as unknown as HTMLElement | undefined)?.hidden,
    ).toBe(true);

    const waveButton = waveRow.querySelector("button")!;

    // Open wave
    waveRow.click();
    expect(waveButton.getAttribute("aria-expanded")).toBe("true");
    expect((laneRows[0] as unknown as HTMLElement | undefined)?.hidden).toBe(
      false,
    );
    expect((laneRows[1] as unknown as HTMLElement | undefined)?.hidden).toBe(
      false,
    );
    expect(
      (disagreementRows[0] as unknown as HTMLElement | undefined)?.hidden,
    ).toBe(false);

    // Close wave
    waveRow.click();
    expect(waveButton.getAttribute("aria-expanded")).toBe("false");
    expect((laneRows[0] as unknown as HTMLElement | undefined)?.hidden).toBe(
      true,
    );
    expect((laneRows[1] as unknown as HTMLElement | undefined)?.hidden).toBe(
      true,
    );
    expect(
      (disagreementRows[0] as unknown as HTMLElement | undefined)?.hidden,
    ).toBe(true);
  });

  test("the wave row's button is reachable by keyboard and carries aria-expanded in both states", async () => {
    const page = await loadPage(statusAt());
    const doc = page.window.document;
    const waveRow = doc.querySelector("tr.wave") as unknown as HTMLElement;
    expect(waveRow).not.toBeNull();
    expect(waveRow.getAttribute("role")).not.toBe("button");
    expect(waveRow.getAttribute("tabindex")).toBeNull();
    const button = waveRow.querySelector("button")!;
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("tabindex")).toBe("0");
    expect(button.getAttribute("aria-expanded")).toBe("false");

    press(button, "Enter");
    expect(button.getAttribute("aria-expanded")).toBe("true");

    press(button, " ");
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  test("the wave row shows which wave it is and how many lanes are inside", async () => {
    const page = await loadPage(mixedStatus);
    const doc = page.window.document;
    const waveRows = doc.querySelectorAll("tr.wave");
    expect(waveRows[0]?.textContent).toContain("wave T");
    expect(waveRows[0]?.textContent).toContain("4 lanes");
    expect(waveRows[1]?.textContent).toContain("wave U");
    expect(waveRows[1]?.textContent).toContain("1 lane");
  });

  test("an opened wave is still open after a re-render", async () => {
    const page = await loadPage(mixedStatus);
    const doc = page.window.document;
    const waveRows = doc.querySelectorAll("tr.wave");
    expect(waveRows.length).toBe(2);

    const waveT = waveRows[0] as unknown as HTMLElement;
    const waveU = waveRows[1] as unknown as HTMLElement;
    expect(waveT.dataset.wave).toBe("T");
    expect(waveU.dataset.wave).toBe("U");

    // Open wave T
    waveT.click();
    expect(waveT.querySelector("button")?.getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(waveU.querySelector("button")?.getAttribute("aria-expanded")).toBe(
      "false",
    );

    // Re-render via SSE status event
    page.source.emit("status", JSON.stringify(mixedStatus));

    const updatedWaveRows = doc.querySelectorAll("tr.wave");
    const updatedWaveT = updatedWaveRows[0] as unknown as HTMLElement;
    const updatedWaveU = updatedWaveRows[1] as unknown as HTMLElement;

    expect(
      updatedWaveT.querySelector("button")?.getAttribute("aria-expanded"),
    ).toBe("true");
    expect(
      updatedWaveU.querySelector("button")?.getAttribute("aria-expanded"),
    ).toBe("false");

    const lanesT = doc.querySelectorAll(
      'tr.lane[data-wave="T"]',
    ) as unknown as NodeListOf<HTMLElement>;
    for (const lane of lanesT) {
      expect(lane.hidden).toBe(false);
    }
    const lanesU = doc.querySelectorAll(
      'tr.lane[data-wave="U"]',
    ) as unknown as NodeListOf<HTMLElement>;
    for (const lane of lanesU) {
      expect(lane.hidden).toBe(true);
    }
  });

  test("a re-render leaves the focused wave's button focused, and a vanished row gets nothing back", async () => {
    const page = await loadPage(mixedStatus);
    const doc = page.window.document;
    const waveT = doc.querySelector(
      'tr.wave[data-wave="T"]',
    ) as unknown as HTMLElement;
    const waveTButton = waveT.querySelector("button")!;
    waveTButton.focus();
    expect(doc.activeElement).toBe(waveTButton);

    page.source.emit("status", JSON.stringify(mixedStatus));
    const reRendered = doc.querySelector(
      'tr.wave[data-wave="T"]',
    ) as unknown as HTMLElement;
    const reRenderedButton = reRendered.querySelector("button")!;
    expect(reRendered).not.toBe(waveT);
    expect(doc.activeElement).toBe(reRenderedButton);

    // A wave that is gone is gone: do not guess at a neighbour row.
    const withoutTwo: WaveStatus = {
      generatedAt: "now",
      waves: mixedStatus.waves.filter((wave) => wave.id !== "T"),
    };
    page.source.emit("status", JSON.stringify(withoutTwo));
    expect(doc.querySelector('tr.wave[data-wave="T"]')).toBeNull();
    expect(doc.activeElement).toBe(doc.body);
  });

  test("with sorting on, focus follows lane identity across a re-render, not row position", async () => {
    const before: WaveStatus = {
      generatedAt: "now",
      waves: [
        {
          id: "W",
          lanes: [
            {
              wave: "W",
              lane: "l_hot",
              derived: {
                alive: true,
                log: { bytes: 10, mtimeMs: 3000, tail: "" },
              },
              disagreements: [],
            },
            {
              wave: "W",
              lane: "l_cold",
              derived: {
                alive: true,
                log: { bytes: 10, mtimeMs: 1000, tail: "" },
              },
              disagreements: [],
            },
          ],
        },
      ],
    } as WaveStatus;
    const after: WaveStatus = {
      generatedAt: "now",
      waves: [
        {
          id: "W",
          lanes: [
            {
              wave: "W",
              lane: "l_hot",
              derived: {
                alive: true,
                log: { bytes: 10, mtimeMs: 1000, tail: "" },
              },
              disagreements: [],
            },
            {
              wave: "W",
              lane: "l_cold",
              derived: {
                alive: true,
                log: { bytes: 10, mtimeMs: 3000, tail: "" },
              },
              disagreements: [],
            },
          ],
        },
      ],
    } as WaveStatus;

    const page = await loadPage(before);
    const doc = page.window.document;
    (doc.querySelector("tr.wave") as unknown as HTMLElement).click();
    const hot = doc.querySelector(
      'tr.lane[data-lane="l_hot"]',
    ) as unknown as HTMLElement;
    const hotButton = hot.querySelector("button")!;
    hotButton.focus();
    expect(doc.activeElement).toBe(hotButton);
    expect(
      (doc.querySelectorAll("tr.lane")[0] as unknown as HTMLElement).dataset
        .lane,
    ).toBe("l_hot");

    page.source.emit("status", JSON.stringify(after));

    // Prove the re-sort actually happened: l_cold is now the more recently
    // updated lane, so it must lead and l_hot must have moved off row 0. If
    // sorting silently stopped working, l_hot would stay at index 0 and a
    // position-based focus restore would satisfy the assertions below just
    // as well as an identity-based one — this is what rules that out.
    const rowsAfter = doc.querySelectorAll("tr.lane");
    expect((rowsAfter[0] as unknown as HTMLElement).dataset.lane).toBe(
      "l_cold",
    );
    expect((rowsAfter[1] as unknown as HTMLElement).dataset.lane).toBe("l_hot");

    const hotAgain = doc.querySelector(
      'tr.lane[data-lane="l_hot"]',
    ) as unknown as HTMLElement;
    const hotAgainButton = hotAgain.querySelector("button")!;
    expect(hotAgain).not.toBe(hot);
    expect(hotAgain).toBe(rowsAfter[1]);
    expect(doc.activeElement).toBe(hotAgainButton);
  });

  test("each wave control names the one element that holds its rows, and the names are unique", async () => {
    const page = await loadPage(mixedStatus);
    const doc = page.window.document;
    const waveRows = Array.from(doc.querySelectorAll("tr.wave"));
    expect(waveRows.length).toBe(2);

    const seen = new Set<string>();
    for (const waveRow of waveRows) {
      const control = waveRow
        .querySelector("button")
        ?.getAttribute("aria-controls");
      expect(control).toBeTruthy();
      expect(seen.has(control!)).toBe(false);
      seen.add(control!);
      const group = doc.getElementById(control!);
      expect(group).not.toBeNull();
      for (const lane of group!.querySelectorAll("tr.lane")) {
        expect(lane.getAttribute("data-wave")).toBe(
          waveRow.getAttribute("data-wave"),
        );
      }
    }
  });

  test("with sorting on, a lane whose log.mtimeMs is newest appears first, and a lane with no log is last", async () => {
    const statusWithMtimes: WaveStatus = {
      generatedAt: "now",
      waves: [
        {
          id: "W",
          lanes: [
            {
              wave: "W",
              lane: "l_mid",
              derived: {
                alive: true,
                log: { bytes: 10, mtimeMs: 2000, tail: "" },
              },
              disagreements: [],
            },
            {
              wave: "W",
              lane: "l_old",
              derived: {
                alive: true,
                log: { bytes: 10, mtimeMs: 1000, tail: "" },
              },
              disagreements: [],
            },
            {
              wave: "W",
              lane: "l_new",
              derived: {
                alive: true,
                log: { bytes: 10, mtimeMs: 3000, tail: "" },
              },
              disagreements: [],
            },
            {
              wave: "W",
              lane: "l_nolog",
              derived: { alive: false },
              disagreements: [],
            },
          ],
        },
      ],
    } as WaveStatus;

    const page = await loadPage(statusWithMtimes);
    const doc = page.window.document;
    const lanes = Array.from(doc.querySelectorAll('tr.lane[data-wave="W"]'));
    expect(lanes.length).toBe(4);

    const laneIds = lanes.map((el) => el.getAttribute("data-lane"));
    expect(laneIds[0]).toBe("l_new");
    expect(laneIds[1]).toBe("l_mid");
    expect(laneIds[2]).toBe("l_old");
    expect(laneIds[3]).toBe("l_nolog");
  });

  test("with sorting on, the wave whose most recent lane is newest renders first, with every wave collapsed", async () => {
    const statusWithWaves: WaveStatus = {
      generatedAt: "now",
      waves: [
        {
          id: "W_mid",
          lanes: [
            {
              wave: "W_mid",
              lane: "l_mid",
              derived: {
                alive: true,
                log: { bytes: 10, mtimeMs: 2000, tail: "" },
              },
              disagreements: [],
            },
          ],
        },
        {
          id: "W_old",
          lanes: [
            {
              wave: "W_old",
              lane: "l_old",
              derived: {
                alive: true,
                log: { bytes: 10, mtimeMs: 1000, tail: "" },
              },
              disagreements: [],
            },
          ],
        },
        {
          id: "W_new",
          lanes: [
            {
              wave: "W_new",
              lane: "l_new",
              derived: {
                alive: true,
                log: { bytes: 10, mtimeMs: 3000, tail: "" },
              },
              disagreements: [],
            },
          ],
        },
      ],
    } as WaveStatus;

    const page = await loadPage(statusWithWaves);
    const doc = page.window.document;

    // Assert every wave is collapsed by default (the reported case)
    const waveRows = Array.from(doc.querySelectorAll("tr.wave"));
    expect(waveRows.length).toBe(3);
    for (const waveRow of waveRows) {
      expect(
        waveRow.querySelector("button")?.getAttribute("aria-expanded"),
      ).toBe("false");
    }
    const laneRows = Array.from(doc.querySelectorAll("tr.lane"));
    expect(laneRows.length).toBe(3);
    for (const laneRow of laneRows) {
      expect((laneRow as unknown as HTMLElement).hidden).toBe(true);
    }

    // With sorting on, W_new (3000) renders first, followed by W_mid (2000), then W_old (1000)
    const waveIds = waveRows.map((el) => el.getAttribute("data-wave"));
    expect(waveIds).toEqual(["W_new", "W_mid", "W_old"]);
    expect(waveIds[0]).toBe("W_new");
  });

  test("flipping the switch off restores server order at both levels", async () => {
    const multiLevelStatus: WaveStatus = {
      generatedAt: "now",
      waves: [
        {
          id: "W_server1",
          lanes: [
            {
              wave: "W_server1",
              lane: "l_s1_old",
              derived: {
                alive: true,
                log: { bytes: 10, mtimeMs: 1000, tail: "" },
              },
              disagreements: [],
            },
            {
              wave: "W_server1",
              lane: "l_s1_new",
              derived: {
                alive: true,
                log: { bytes: 10, mtimeMs: 2000, tail: "" },
              },
              disagreements: [],
            },
          ],
        },
        {
          id: "W_server2",
          lanes: [
            {
              wave: "W_server2",
              lane: "l_s2_old",
              derived: {
                alive: true,
                log: { bytes: 10, mtimeMs: 3000, tail: "" },
              },
              disagreements: [],
            },
            {
              wave: "W_server2",
              lane: "l_s2_new",
              derived: {
                alive: true,
                log: { bytes: 10, mtimeMs: 4000, tail: "" },
              },
              disagreements: [],
            },
          ],
        },
      ],
    } as WaveStatus;

    const page = await loadPage(multiLevelStatus);
    const doc = page.window.document;
    const switchEl = doc.getElementById(
      "sort-switch",
    ) as unknown as HTMLElement;
    expect(switchEl).not.toBeNull();
    expect(switchEl.getAttribute("aria-checked")).toBe("true");

    // Initially sorted newest first at both wave and lane levels
    let waveRows = Array.from(doc.querySelectorAll("tr.wave"));
    expect(waveRows.map((w) => w.getAttribute("data-wave"))).toEqual([
      "W_server2",
      "W_server1",
    ]);
    let lanesW2 = Array.from(
      doc.querySelectorAll('tr.lane[data-wave="W_server2"]'),
    );
    expect(lanesW2.map((l) => l.getAttribute("data-lane"))).toEqual([
      "l_s2_new",
      "l_s2_old",
    ]);
    let lanesW1 = Array.from(
      doc.querySelectorAll('tr.lane[data-wave="W_server1"]'),
    );
    expect(lanesW1.map((l) => l.getAttribute("data-lane"))).toEqual([
      "l_s1_new",
      "l_s1_old",
    ]);

    // Flip switch off
    switchEl.click();
    expect(switchEl.getAttribute("aria-checked")).toBe("false");

    // Server order is restored at both levels
    waveRows = Array.from(doc.querySelectorAll("tr.wave"));
    expect(waveRows.map((w) => w.getAttribute("data-wave"))).toEqual([
      "W_server1",
      "W_server2",
    ]);
    lanesW1 = Array.from(
      doc.querySelectorAll('tr.lane[data-wave="W_server1"]'),
    );
    expect(lanesW1.map((l) => l.getAttribute("data-lane"))).toEqual([
      "l_s1_old",
      "l_s1_new",
    ]);
    lanesW2 = Array.from(
      doc.querySelectorAll('tr.lane[data-wave="W_server2"]'),
    );
    expect(lanesW2.map((l) => l.getAttribute("data-lane"))).toEqual([
      "l_s2_old",
      "l_s2_new",
    ]);

    // Flip switch on again
    switchEl.click();
    expect(switchEl.getAttribute("aria-checked")).toBe("true");

    waveRows = Array.from(doc.querySelectorAll("tr.wave"));
    expect(waveRows.map((w) => w.getAttribute("data-wave"))).toEqual([
      "W_server2",
      "W_server1",
    ]);
    lanesW2 = Array.from(
      doc.querySelectorAll('tr.lane[data-wave="W_server2"]'),
    );
    expect(lanesW2.map((l) => l.getAttribute("data-lane"))).toEqual([
      "l_s2_new",
      "l_s2_old",
    ]);
    lanesW1 = Array.from(
      doc.querySelectorAll('tr.lane[data-wave="W_server1"]'),
    );
    expect(lanesW1.map((l) => l.getAttribute("data-lane"))).toEqual([
      "l_s1_new",
      "l_s1_old",
    ]);
  });

  test("a wave with no timestamped lane sorts last", async () => {
    const statusWithNoTimestamp: WaveStatus = {
      generatedAt: "now",
      waves: [
        {
          id: "W_nolog",
          lanes: [
            {
              wave: "W_nolog",
              lane: "l_none",
              derived: { alive: false },
              disagreements: [],
            },
          ],
        },
        {
          id: "W_empty",
          lanes: [],
        },
        {
          id: "W_old",
          lanes: [
            {
              wave: "W_old",
              lane: "l_old",
              derived: {
                alive: true,
                log: { bytes: 10, mtimeMs: 1000, tail: "" },
              },
              disagreements: [],
            },
          ],
        },
        {
          id: "W_new",
          lanes: [
            {
              wave: "W_new",
              lane: "l_new",
              derived: {
                alive: true,
                log: { bytes: 10, mtimeMs: 3000, tail: "" },
              },
              disagreements: [],
            },
          ],
        },
      ],
    } as WaveStatus;

    const page = await loadPage(statusWithNoTimestamp);
    const doc = page.window.document;
    const waveRows = Array.from(doc.querySelectorAll("tr.wave"));
    const waveIds = waveRows.map((el) => el.getAttribute("data-wave"));
    expect(waveIds).toEqual(["W_new", "W_old", "W_nolog", "W_empty"]);
  });

  test("an expanded wave stays expanded across a re-sort, and an open log stays open when its wave moves", async () => {
    const beforeStatus: WaveStatus = {
      generatedAt: "now",
      waves: [
        {
          id: "W_A",
          lanes: [
            {
              wave: "W_A",
              lane: "l_a",
              derived: {
                alive: true,
                log: { bytes: 10, mtimeMs: 1000, tail: "" },
              },
              disagreements: [],
            },
          ],
        },
        {
          id: "W_B",
          lanes: [
            {
              wave: "W_B",
              lane: "l_b",
              derived: {
                alive: true,
                log: { bytes: 10, mtimeMs: 2000, tail: "" },
              },
              disagreements: [],
            },
          ],
        },
      ],
    } as WaveStatus;

    const afterStatus: WaveStatus = {
      generatedAt: "now",
      waves: [
        {
          id: "W_A",
          lanes: [
            {
              wave: "W_A",
              lane: "l_a",
              derived: {
                alive: true,
                log: { bytes: 10, mtimeMs: 3000, tail: "" },
              },
              disagreements: [],
            },
          ],
        },
        {
          id: "W_B",
          lanes: [
            {
              wave: "W_B",
              lane: "l_b",
              derived: {
                alive: true,
                log: { bytes: 10, mtimeMs: 2000, tail: "" },
              },
              disagreements: [],
            },
          ],
        },
      ],
    } as WaveStatus;

    const page = await loadPage(beforeStatus, "test log for W_A/l_a");
    const doc = page.window.document;

    // Initial state with sorting on: W_B (2000) is first, W_A (1000) is second
    let waveRows = Array.from(doc.querySelectorAll("tr.wave"));
    expect(waveRows.map((r) => r.getAttribute("data-wave"))).toEqual([
      "W_B",
      "W_A",
    ]);

    // Expand W_A
    const waveAButton = doc.querySelector(
      'tr.wave[data-wave="W_A"] button',
    ) as unknown as HTMLElement;
    waveAButton.click();
    expect(waveAButton.getAttribute("aria-expanded")).toBe("true");
    const laneA = doc.querySelector(
      'tr.lane[data-wave="W_A"][data-lane="l_a"]',
    ) as unknown as HTMLElement;
    expect(laneA.hidden).toBe(false);

    // Open log for W_A / l_a
    laneA.click();
    await vi.waitFor(() => {
      expect(page.fetches).toContain("/api/log/W_A/l_a?tail=16");
      expect(
        (doc.getElementById("log-pane") as HTMLElement | null)?.hidden,
      ).toBe(false);
    });
    expect(doc.getElementById("log-lane")?.textContent).toBe("W_A/l_a");
    expect(laneA.classList.contains("active")).toBe(true);

    // Emit new status where W_A becomes newer (3000 > 2000)
    // This moves W_A from second to first row!
    page.source.emit("status", JSON.stringify(afterStatus));

    // Prove the re-sort moved W_A to the first position
    waveRows = Array.from(doc.querySelectorAll("tr.wave"));
    expect(waveRows.map((r) => r.getAttribute("data-wave"))).toEqual([
      "W_A",
      "W_B",
    ]);

    // W_A is still expanded after moving
    const waveAButtonAfter = doc.querySelector(
      'tr.wave[data-wave="W_A"] button',
    ) as unknown as HTMLElement;
    expect(waveAButtonAfter.getAttribute("aria-expanded")).toBe("true");
    const laneAAfter = doc.querySelector(
      'tr.lane[data-wave="W_A"][data-lane="l_a"]',
    ) as unknown as HTMLElement;
    expect(laneAAfter.hidden).toBe(false);

    // The open log is still open and active row is preserved on the moved lane
    const logPane = doc.getElementById("log-pane") as HTMLElement | null;
    expect(logPane?.hidden).toBe(false);
    expect(doc.getElementById("log-lane")?.textContent).toBe("W_A/l_a");
    expect(laneAAfter.classList.contains("active")).toBe(true);

    // Now flip the sort switch off to restore server order (W_A, W_B)
    const switchEl = doc.getElementById(
      "sort-switch",
    ) as unknown as HTMLElement;
    switchEl.click();
    expect(switchEl.getAttribute("aria-checked")).toBe("false");
    expect(waveAButtonAfter.getAttribute("aria-expanded")).toBe("true");
    expect(logPane?.hidden).toBe(false);
    expect(doc.getElementById("log-lane")?.textContent).toBe("W_A/l_a");
    expect(laneAAfter.classList.contains("active")).toBe(true);
  });

  test("the switch has an accessible name, flipping it restores the server order without a refresh, and the choice survives a reload", async () => {
    const statusWithMtimes: WaveStatus = {
      generatedAt: "now",
      waves: [
        {
          id: "W",
          lanes: [
            {
              wave: "W",
              lane: "l_server1",
              derived: {
                alive: true,
                log: { bytes: 10, mtimeMs: 1000, tail: "" },
              },
              disagreements: [],
            },
            {
              wave: "W",
              lane: "l_server2",
              derived: {
                alive: true,
                log: { bytes: 10, mtimeMs: 3000, tail: "" },
              },
              disagreements: [],
            },
          ],
        },
      ],
    } as WaveStatus;

    const page = await loadPage(statusWithMtimes);
    const doc = page.window.document;
    const switchEl = doc.getElementById(
      "sort-switch",
    ) as unknown as HTMLElement;
    expect(switchEl).not.toBeNull();
    expect(switchEl.getAttribute("role")).toBe("switch");
    expect(switchEl.getAttribute("aria-label")).toBeTruthy();
    expect(switchEl.getAttribute("aria-label")).toMatch(/sort/i);
    expect(switchEl.getAttribute("aria-checked")).toBe("true");

    // Initially sorted newest first
    let lanes = Array.from(doc.querySelectorAll('tr.lane[data-wave="W"]'));
    expect(lanes.map((l) => l.getAttribute("data-lane"))).toEqual([
      "l_server2",
      "l_server1",
    ]);

    const fetchCountBefore = page.fetches.length;

    // Flip switch off
    switchEl.click();
    expect(switchEl.getAttribute("aria-checked")).toBe("false");

    // Server order is restored without any network fetch
    lanes = Array.from(doc.querySelectorAll('tr.lane[data-wave="W"]'));
    expect(lanes.map((l) => l.getAttribute("data-lane"))).toEqual([
      "l_server1",
      "l_server2",
    ]);
    expect(page.fetches.length).toBe(fetchCountBefore);

    // Stored preference is saved in localStorage
    expect(page.window.localStorage.getItem("wave-status:sort")).toBe("false");

    // Survives a reload
    const reloadedPage = await loadPage(statusWithMtimes, undefined, {
      storage: { "wave-status:sort": "false" },
    });
    const reloadedDoc = reloadedPage.window.document;
    const reloadedSwitch = reloadedDoc.getElementById(
      "sort-switch",
    ) as unknown as HTMLElement;
    expect(reloadedSwitch.getAttribute("aria-checked")).toBe("false");
    const reloadedLanes = Array.from(
      reloadedDoc.querySelectorAll('tr.lane[data-wave="W"]'),
    );
    expect(reloadedLanes.map((l) => l.getAttribute("data-lane"))).toEqual([
      "l_server1",
      "l_server2",
    ]);
  });

  test("a localStorage read that throws still renders with sorting on", async () => {
    const statusWithMtimes: WaveStatus = {
      generatedAt: "now",
      waves: [
        {
          id: "W",
          lanes: [
            {
              wave: "W",
              lane: "l_old",
              derived: {
                alive: true,
                log: { bytes: 10, mtimeMs: 1000, tail: "" },
              },
              disagreements: [],
            },
            {
              wave: "W",
              lane: "l_new",
              derived: {
                alive: true,
                log: { bytes: 10, mtimeMs: 3000, tail: "" },
              },
              disagreements: [],
            },
          ],
        },
      ],
    } as WaveStatus;

    const page = await loadPage(statusWithMtimes, undefined, {
      mockStorageError: true,
    });
    const doc = page.window.document;
    const switchEl = doc.getElementById(
      "sort-switch",
    ) as unknown as HTMLElement;
    expect(switchEl.getAttribute("aria-checked")).toBe("true");

    const lanes = Array.from(doc.querySelectorAll('tr.lane[data-wave="W"]'));
    expect(lanes.map((l) => l.getAttribute("data-lane"))).toEqual([
      "l_new",
      "l_old",
    ]);
  });

  test("the sort switch control resolves its border to the control token", async () => {
    const page = await loadPage(statusAt());
    const doc = page.window.document;
    const sheet = doc.styleSheets[0];
    const style = await pageStyle();

    interface StyleRuleLike {
      readonly selectorText: string;
      readonly style: {
        readonly borderColor?: string;
        readonly border?: string;
      };
    }

    const rules = Array.from(
      sheet.cssRules,
    ) as unknown as readonly StyleRuleLike[];
    const sortSwitch = doc.getElementById("sort-switch");
    expect(sortSwitch).not.toBeNull();

    const rule = rules.find(
      (r) =>
        r.selectorText !== undefined &&
        !r.selectorText.includes(":") &&
        sortSwitch!.matches(r.selectorText) &&
        Boolean(r.style.borderColor || r.style.border),
    );
    expect(rule?.style.borderColor).toBe("var(--color-border-control)");

    expect(style).toMatch(
      /#sort-switch\s*\{[^}]*border:\s*1px solid var\(--color-border-control\)/,
    );
    expect(style).toMatch(
      /#sort-switch:hover\s*\{[^}]*border-color:\s*var\(--color-border-control-hover\)/,
    );
  });

  test("the follow control renders with an accessible name when the open lane is alive, and is absent when it is not", async () => {
    const aliveStatus: WaveStatus = {
      generatedAt: "now",
      waves: [
        {
          id: "T",
          lanes: [
            {
              wave: "T",
              lane: "t1",
              derived: { alive: true },
              disagreements: [],
            },
          ],
        },
      ],
    } as WaveStatus;

    const page = await loadPage(aliveStatus);
    const doc = page.window.document;
    const row = doc.querySelector("tr.lane");
    press(row!.querySelector("button")!, "Enter");

    // Wait for the follow control to be present when lane is alive
    await vi.waitFor(() => {
      const checkbox = doc.getElementById("log-follow");
      expect(checkbox).not.toBeNull();
    });

    const followCheckbox = doc.getElementById(
      "log-follow",
    ) as unknown as HTMLInputElement | null;
    expect(followCheckbox?.getAttribute("id")).toBe("log-follow");

    const followLabel = doc.querySelector('label[for="log-follow"]');
    expect(followLabel).not.toBeNull();
    expect(followLabel?.textContent?.trim().toLowerCase()).toContain("follow");

    // Now emit a status where the lane is not alive
    const deadStatus: WaveStatus = {
      generatedAt: "now",
      waves: [
        {
          id: "T",
          lanes: [
            {
              wave: "T",
              lane: "t1",
              derived: { alive: false },
              disagreements: [],
            },
          ],
        },
      ],
    } as WaveStatus;
    page.source.emit("status", JSON.stringify(deadStatus));

    // Follow control should be removed when lane is not alive
    await vi.waitFor(() => {
      const checkbox = doc.getElementById("log-follow");
      expect(checkbox).toBeNull();
    });
  });

  test("with follow on, a refresh re-fetches that lane's log and leaves the body scrolled to the bottom", async () => {
    const aliveStatus: WaveStatus = {
      generatedAt: "now",
      waves: [
        {
          id: "T",
          lanes: [
            {
              wave: "T",
              lane: "t1",
              derived: { alive: true },
              disagreements: [],
            },
          ],
        },
      ],
    } as WaveStatus;

    const page = await loadPage(aliveStatus, "initial log");
    const doc = page.window.document;
    const row = doc.querySelector("tr.lane");
    press(row!.querySelector("button")!, "Enter");
    await vi.waitFor(() => {
      expect(
        (doc.getElementById("log-pane") as HTMLElement | null)?.hidden,
      ).toBe(false);
    });

    const logView = doc.getElementById("log") as HTMLElement | null;
    expect(logView).not.toBeNull();

    // Set up scrollHeight and clientHeight mocking
    let scrollTopValue = 0;
    Object.defineProperty(logView!, "scrollHeight", {
      get: () => 1000,
      configurable: true,
    });
    Object.defineProperty(logView!, "clientHeight", {
      get: () => 100,
      configurable: true,
    });
    Object.defineProperty(logView!, "scrollTop", {
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
      configurable: true,
    });

    // Check the follow checkbox
    const followCheckbox = doc.getElementById(
      "log-follow",
    ) as unknown as HTMLInputElement | null;
    expect(followCheckbox).not.toBeNull();
    followCheckbox!.checked = true;
    const changeEvent = new (
      followCheckbox!.ownerDocument!
        .defaultView as unknown as { Event: typeof Event }
    ).Event("change", { bubbles: true });
    followCheckbox!.dispatchEvent(changeEvent);

    const fetchCountBefore = page.fetches.length;

    // Emit a new status to trigger a refresh
    page.source.emit("status", JSON.stringify(aliveStatus));

    // Wait for the refetch to happen and scrollTop to be updated
    await vi.waitFor(() => {
      expect(page.fetches.length).toBeGreaterThan(fetchCountBefore);
      expect(logView!.scrollTop).toBe(logView!.scrollHeight);
    });
  });

  test("with follow off, a refresh does not change the scroll position", async () => {
    const aliveStatus: WaveStatus = {
      generatedAt: "now",
      waves: [
        {
          id: "T",
          lanes: [
            {
              wave: "T",
              lane: "t1",
              derived: { alive: true },
              disagreements: [],
            },
          ],
        },
      ],
    } as WaveStatus;

    const page = await loadPage(aliveStatus, "initial log");
    const doc = page.window.document;
    const row = doc.querySelector("tr.lane");
    press(row!.querySelector("button")!, "Enter");
    await vi.waitFor(() => {
      expect(
        (doc.getElementById("log-pane") as HTMLElement | null)?.hidden,
      ).toBe(false);
    });

    const logView = doc.getElementById("log") as HTMLElement | null;
    expect(logView).not.toBeNull();

    // Set up scrollHeight and clientHeight mocking
    Object.defineProperty(logView!, "scrollHeight", {
      get: () => 1000,
      configurable: true,
    });
    Object.defineProperty(logView!, "clientHeight", {
      get: () => 100,
      configurable: true,
    });

    // Track scrollTop with a real backing variable, so a write during the
    // refresh actually shows up here instead of vanishing into a setter
    // that discards it.
    const savedScrollTop = 500;
    let scrollTopValue = savedScrollTop;
    Object.defineProperty(logView!, "scrollTop", {
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
      configurable: true,
    });

    const fetchCountBefore = page.fetches.length;

    // Do NOT check the follow checkbox (keep follow off)
    const followCheckbox = doc.getElementById(
      "log-follow",
    ) as unknown as HTMLInputElement | null;
    expect(followCheckbox?.checked).toBe(false);

    // Emit a new status to trigger a refresh
    page.source.emit("status", JSON.stringify(aliveStatus));

    // Wait a moment for any async operations
    await new Promise((resolve) => setTimeout(resolve, 50));

    // With follow off, maybeFollow() must return before it ever fetches the
    // log tail or touches scrollTop: no new request, and the recorded
    // scrollTop write stays at its prior value.
    expect(page.fetches.length).toBe(fetchCountBefore);
    expect(logView!.scrollTop).toBe(savedScrollTop);
  });

  test("switching to a different alive lane leaves the reused follow control unticked", async () => {
    const twoLaneStatus: WaveStatus = {
      generatedAt: "now",
      waves: [
        {
          id: "T",
          lanes: [
            {
              wave: "T",
              lane: "t1",
              derived: { alive: true },
              disagreements: [],
            },
            {
              wave: "T",
              lane: "t2",
              derived: { alive: true },
              disagreements: [],
            },
          ],
        },
      ],
    } as WaveStatus;

    const page = await loadPage(twoLaneStatus);
    const doc = page.window.document;
    const rows = doc.querySelectorAll("tr.lane");
    expect(rows.length).toBe(2);

    // Follow lane t1.
    press(rows[0]!.querySelector("button")!, "Enter");
    await vi.waitFor(() => {
      expect(doc.getElementById("log-follow")).not.toBeNull();
    });
    const followCheckboxT1 = doc.getElementById(
      "log-follow",
    ) as unknown as HTMLInputElement;
    followCheckboxT1.checked = true;
    followCheckboxT1.dispatchEvent(
      new (
        followCheckboxT1.ownerDocument!.defaultView as unknown as {
          Event: typeof Event;
        }
      ).Event("change", { bubbles: true }),
    );
    await vi.waitFor(() => {
      expect(followCheckboxT1.checked).toBe(true);
    });

    // Open lane t2 — the follow control element is reused, not recreated,
    // since it already exists and t2 is alive too.
    press(rows[1]!.querySelector("button")!, "Enter");
    await vi.waitFor(() => {
      expect(doc.getElementById("log-lane")?.textContent).toBe("T/t2");
      expect(page.fetches).toContain("/api/log/T/t2?tail=16");
    });

    // The checkbox itself — not a closure variable the test cannot see —
    // must not still claim the view is live.
    const followCheckboxT2 = doc.getElementById(
      "log-follow",
    ) as unknown as HTMLInputElement;
    expect(followCheckboxT2).not.toBeNull();
    expect(followCheckboxT2.checked).toBe(false);

    // Confirm it behaviourally too: a status render for the new lane must
    // not start a follow refresh — if `following` were still true under
    // the hood, this would fetch again.
    const fetchCountBefore = page.fetches.length;
    page.source.emit("status", JSON.stringify(twoLaneStatus));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(page.fetches.length).toBe(fetchCountBefore);
  });

  test("a follow refresh whose fetch rejects turns follow off, reports it, and leaves no unhandled rejection", async () => {
    const aliveStatus: WaveStatus = {
      generatedAt: "now",
      waves: [
        {
          id: "T",
          lanes: [
            {
              wave: "T",
              lane: "t1",
              derived: { alive: true },
              disagreements: [],
            },
          ],
        },
      ],
    } as WaveStatus;

    let calls = 0;
    const page = await loadPage(aliveStatus, () => {
      calls++;
      if (calls === 1) {
        return new Response("initial log", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      return Promise.reject(new Error("network down"));
    });
    const doc = page.window.document;
    const row = doc.querySelector("tr.lane");
    press(row!.querySelector("button")!, "Enter");
    // Wait for the open's own fetch (call #1) to land before starting
    // follow, so the follow refresh (call #2, the one that rejects) is
    // unambiguously the second call.
    await vi.waitFor(() => {
      expect(doc.getElementById("log-follow")).not.toBeNull();
      expect(doc.getElementById("log")?.textContent).toContain(
        "initial log",
      );
    });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const followCheckbox = doc.getElementById(
        "log-follow",
      ) as unknown as HTMLInputElement;
      followCheckbox.checked = true;
      followCheckbox.dispatchEvent(
        new (
          followCheckbox.ownerDocument!.defaultView as unknown as {
            Event: typeof Event;
          }
        ).Event("change", { bubbles: true }),
      );

      // The change handler's own follow refresh (call #2) is the one that
      // rejects. Follow must not remain silently on over that failure.
      await vi.waitFor(() => {
        expect(followCheckbox.checked).toBe(false);
      });
      expect(doc.getElementById("log-size")?.textContent).toMatch(
        /follow.*failed/i,
      );

      // Give any unhandled rejection a turn to surface before asserting
      // none did.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("a follow refresh that resolves non-ok turns follow off and reports it, instead of leaving the box ticked over stale content", async () => {
    const aliveStatus: WaveStatus = {
      generatedAt: "now",
      waves: [
        {
          id: "T",
          lanes: [
            {
              wave: "T",
              lane: "t1",
              derived: { alive: true },
              disagreements: [],
            },
          ],
        },
      ],
    } as WaveStatus;

    let calls = 0;
    const page = await loadPage(aliveStatus, () => {
      calls++;
      if (calls === 1) {
        return new Response("initial log", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      return new Response("server error", { status: 500 });
    });
    const doc = page.window.document;
    const row = doc.querySelector("tr.lane");
    press(row!.querySelector("button")!, "Enter");
    // Wait for the open's own fetch (call #1) to land before starting
    // follow, so the follow refresh (call #2, the one that fails) is
    // unambiguously the second call and the race between the two
    // response chains cannot flip which content ends up on screen first.
    await vi.waitFor(() => {
      expect(doc.getElementById("log-follow")).not.toBeNull();
      expect(doc.getElementById("log")?.textContent).toContain(
        "initial log",
      );
    });

    const followCheckbox = doc.getElementById(
      "log-follow",
    ) as unknown as HTMLInputElement;
    followCheckbox.checked = true;
    followCheckbox.dispatchEvent(
      new (
        followCheckbox.ownerDocument!.defaultView as unknown as {
          Event: typeof Event;
        }
      ).Event("change", { bubbles: true }),
    );

    // The change handler's own follow refresh (call #2) is the one that
    // comes back non-ok. Follow must not remain silently on, ticked, over
    // a view that has stopped updating.
    await vi.waitFor(() => {
      expect(followCheckbox.checked).toBe(false);
    });
    expect(doc.getElementById("log-size")?.textContent).toMatch(
      /follow.*failed/i,
    );
    expect(doc.getElementById("log")?.textContent).toContain("initial log");
  });

  test("when the open lane's alive flips to false, follow turns off and the control disappears", async () => {
    const aliveStatus: WaveStatus = {
      generatedAt: "now",
      waves: [
        {
          id: "T",
          lanes: [
            {
              wave: "T",
              lane: "t1",
              derived: { alive: true },
              disagreements: [],
            },
          ],
        },
      ],
    } as WaveStatus;

    const page = await loadPage(aliveStatus, "initial log");
    const doc = page.window.document;
    const row = doc.querySelector("tr.lane");
    press(row!.querySelector("button")!, "Enter");

    // Wait for the follow control to appear
    await vi.waitFor(() => {
      const checkbox = doc.getElementById("log-follow");
      expect(checkbox).not.toBeNull();
    });

    // Check the follow checkbox
    const followCheckbox = doc.getElementById(
      "log-follow",
    ) as unknown as HTMLInputElement | null;
    followCheckbox!.checked = true;
    const changeEvent = new (
      followCheckbox!.ownerDocument!
        .defaultView as unknown as { Event: typeof Event }
    ).Event("change", { bubbles: true });
    followCheckbox!.dispatchEvent(changeEvent);

    // Emit a status where the lane is no longer alive
    const deadStatus: WaveStatus = {
      generatedAt: "now",
      waves: [
        {
          id: "T",
          lanes: [
            {
              wave: "T",
              lane: "t1",
              derived: { alive: false },
              disagreements: [],
            },
          ],
        },
      ],
    } as WaveStatus;
    page.source.emit("status", JSON.stringify(deadStatus));

    // Wait for the control to disappear
    await vi.waitFor(() => {
      const checkbox = doc.getElementById("log-follow");
      expect(checkbox).toBeNull();
    });

    // Subsequent status updates should not try to fetch the log for a dead lane
    const fetchCountBefore = page.fetches.filter((url) =>
      url.includes("/api/log/"),
    ).length;
    page.source.emit("status", JSON.stringify(deadStatus));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const fetchCountAfter = page.fetches.filter((url) =>
      url.includes("/api/log/"),
    ).length;
    expect(fetchCountAfter).toBe(fetchCountBefore);
  });

  test("when follow is on and user scrolls away from the bottom, follow turns off automatically", async () => {
    const aliveStatus: WaveStatus = {
      generatedAt: "now",
      waves: [
        {
          id: "T",
          lanes: [
            {
              wave: "T",
              lane: "t1",
              derived: { alive: true },
              disagreements: [],
            },
          ],
        },
      ],
    } as WaveStatus;

    const page = await loadPage(aliveStatus, "initial log\nline 2\nline 3");
    const doc = page.window.document;
    const row = doc.querySelector("tr.lane");
    press(row!.querySelector("button")!, "Enter");

    // Wait for the follow control to appear
    await vi.waitFor(() => {
      const checkbox = doc.getElementById("log-follow");
      expect(checkbox).not.toBeNull();
    });

    const logView = doc.getElementById("log") as HTMLElement | null;
    expect(logView).not.toBeNull();

    // Set up scrollHeight and clientHeight mocking
    let scrollTopValue = 900;
    Object.defineProperty(logView!, "scrollHeight", {
      get: () => 1000,
      configurable: true,
    });
    Object.defineProperty(logView!, "clientHeight", {
      get: () => 100,
      configurable: true,
    });
    Object.defineProperty(logView!, "scrollTop", {
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
      configurable: true,
    });

    // Check the follow checkbox
    const followCheckbox = doc.getElementById(
      "log-follow",
    ) as unknown as HTMLInputElement | null;
    expect(followCheckbox).not.toBeNull();
    followCheckbox!.checked = true;
    const changeEvent = new (
      followCheckbox!.ownerDocument!
        .defaultView as unknown as { Event: typeof Event }
    ).Event("change", { bubbles: true });
    followCheckbox!.dispatchEvent(changeEvent);
    expect(followCheckbox!.checked).toBe(true);

    // Simulate user scrolling away from the bottom
    scrollTopValue = 400;
    const scrollEvent = new (
      logView!.ownerDocument!
        .defaultView as unknown as { Event: typeof Event }
    ).Event("scroll", { bubbles: true });
    logView!.dispatchEvent(scrollEvent);

    // Check that follow turned off
    expect(followCheckbox!.checked).toBe(false);
  });

  test("two overlapping follow refreshes for the same lane: an older response resolving after a newer one is discarded", async () => {
    const aliveStatus: WaveStatus = {
      generatedAt: "now",
      waves: [
        {
          id: "T",
          lanes: [
            {
              wave: "T",
              lane: "t1",
              derived: { alive: true },
              disagreements: [],
            },
          ],
        },
      ],
    } as WaveStatus;

    let resolveOpen!: (res: Response) => void;
    const pOpen = new Promise<Response>((resolve) => {
      resolveOpen = resolve;
    });
    let resolveFirst!: (res: Response) => void;
    const pFirst = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    let resolveSecond!: (res: Response) => void;
    const pSecond = new Promise<Response>((resolve) => {
      resolveSecond = resolve;
    });

    let calls = 0;
    const page = await loadPage(aliveStatus, () => {
      calls++;
      if (calls === 1) return pOpen;
      if (calls === 2) return pFirst;
      return pSecond;
    });

    const doc = page.window.document;
    const row = doc.querySelector("tr.lane");
    press(row!.querySelector("button")!, "Enter");
    resolveOpen(new Response("initial", { status: 200 }));
    await vi.waitFor(() => {
      expect(doc.getElementById("log-follow")).not.toBeNull();
    });

    const followCheckbox = doc.getElementById(
      "log-follow",
    ) as unknown as HTMLInputElement;
    followCheckbox.checked = true;
    const changeEvent = new (
      followCheckbox.ownerDocument!.defaultView as unknown as {
        Event: typeof Event;
      }
    ).Event("change", { bubbles: true });
    // Fires the first (older) follow refresh — pending on pFirst.
    followCheckbox.dispatchEvent(changeEvent);

    // A status render is the follow path's other trigger — fire a second
    // (newer) follow refresh before the first resolves, pending on pSecond.
    page.source.emit("status", JSON.stringify(aliveStatus));

    // Resolve the newer request first, then let the older one land after —
    // the older response must never overwrite the newer content.
    resolveSecond(
      new Response("second (newer) content", { status: 200 }),
    );
    await vi.waitFor(() => {
      expect(doc.getElementById("log")?.textContent).toContain(
        "second (newer) content",
      );
    });

    resolveFirst(new Response("first (stale) content", { status: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(doc.getElementById("log")?.textContent).toContain(
      "second (newer) content",
    );
    expect(doc.getElementById("log")?.textContent).not.toContain(
      "first (stale) content",
    );
  });

  test("follow unchecked while a refresh is in flight: the response does not scroll the view", async () => {
    const aliveStatus: WaveStatus = {
      generatedAt: "now",
      waves: [
        {
          id: "T",
          lanes: [
            {
              wave: "T",
              lane: "t1",
              derived: { alive: true },
              disagreements: [],
            },
          ],
        },
      ],
    } as WaveStatus;

    let resolveOpen!: (res: Response) => void;
    const pOpen = new Promise<Response>((resolve) => {
      resolveOpen = resolve;
    });
    let resolveFollow!: (res: Response) => void;
    const pFollow = new Promise<Response>((resolve) => {
      resolveFollow = resolve;
    });

    let calls = 0;
    const page = await loadPage(aliveStatus, () => {
      calls++;
      return calls === 1 ? pOpen : pFollow;
    });

    const doc = page.window.document;
    const row = doc.querySelector("tr.lane");
    press(row!.querySelector("button")!, "Enter");
    resolveOpen(new Response("initial", { status: 200 }));
    await vi.waitFor(() => {
      expect(doc.getElementById("log-follow")).not.toBeNull();
    });

    const logView = doc.getElementById("log") as HTMLElement | null;
    expect(logView).not.toBeNull();
    const savedScrollTop = 500;
    let scrollTopValue = savedScrollTop;
    Object.defineProperty(logView!, "scrollHeight", {
      get: () => 1000,
      configurable: true,
    });
    Object.defineProperty(logView!, "clientHeight", {
      get: () => 100,
      configurable: true,
    });
    Object.defineProperty(logView!, "scrollTop", {
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
      configurable: true,
    });

    const followCheckbox = doc.getElementById(
      "log-follow",
    ) as unknown as HTMLInputElement;
    followCheckbox.checked = true;
    const check = new (
      followCheckbox.ownerDocument!.defaultView as unknown as {
        Event: typeof Event;
      }
    ).Event("change", { bubbles: true });
    // Starts the follow refresh — pending on pFollow.
    followCheckbox.dispatchEvent(check);

    // Uncheck follow while that refresh is still in flight.
    followCheckbox.checked = false;
    const uncheck = new (
      followCheckbox.ownerDocument!.defaultView as unknown as {
        Event: typeof Event;
      }
    ).Event("change", { bubbles: true });
    followCheckbox.dispatchEvent(uncheck);

    // Now let the in-flight refresh land.
    resolveFollow(new Response("late content", { status: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The content may still update, but nothing should have scrolled the
    // view — the user turned follow off before this response arrived.
    expect(logView!.scrollTop).toBe(savedScrollTop);
  });

  test("the user scrolls up while a refresh is in flight: the response does not scroll the view", async () => {
    const aliveStatus: WaveStatus = {
      generatedAt: "now",
      waves: [
        {
          id: "T",
          lanes: [
            {
              wave: "T",
              lane: "t1",
              derived: { alive: true },
              disagreements: [],
            },
          ],
        },
      ],
    } as WaveStatus;

    let resolveOpen!: (res: Response) => void;
    const pOpen = new Promise<Response>((resolve) => {
      resolveOpen = resolve;
    });
    let resolveFollow!: (res: Response) => void;
    const pFollow = new Promise<Response>((resolve) => {
      resolveFollow = resolve;
    });

    let calls = 0;
    const page = await loadPage(aliveStatus, () => {
      calls++;
      return calls === 1 ? pOpen : pFollow;
    });

    const doc = page.window.document;
    const row = doc.querySelector("tr.lane");
    press(row!.querySelector("button")!, "Enter");
    resolveOpen(new Response("initial", { status: 200 }));
    await vi.waitFor(() => {
      expect(doc.getElementById("log-follow")).not.toBeNull();
    });

    const logView = doc.getElementById("log") as HTMLElement | null;
    expect(logView).not.toBeNull();
    let scrollTopValue = 900;
    Object.defineProperty(logView!, "scrollHeight", {
      get: () => 1000,
      configurable: true,
    });
    Object.defineProperty(logView!, "clientHeight", {
      get: () => 100,
      configurable: true,
    });
    Object.defineProperty(logView!, "scrollTop", {
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
      configurable: true,
    });

    const followCheckbox = doc.getElementById(
      "log-follow",
    ) as unknown as HTMLInputElement;
    followCheckbox.checked = true;
    const check = new (
      followCheckbox.ownerDocument!.defaultView as unknown as {
        Event: typeof Event;
      }
    ).Event("change", { bubbles: true });
    // Starts the follow refresh — pending on pFollow.
    followCheckbox.dispatchEvent(check);

    // The user scrolls up to read history while that refresh is in flight.
    scrollTopValue = 400;
    const scrollEvent = new (
      logView!.ownerDocument!.defaultView as unknown as {
        Event: typeof Event;
      }
    ).Event("scroll", { bubbles: true });
    logView!.dispatchEvent(scrollEvent);
    expect(followCheckbox.checked).toBe(false);

    // Now let the in-flight refresh land.
    resolveFollow(new Response("late content", { status: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The scroll position the user chose must not have been overwritten.
    expect(logView!.scrollTop).toBe(400);
  });

  test("each lane column carries its semantic class, matching the header's", async () => {
    const page = await loadPage(mixedStatus);
    const doc = page.window.document;
    const columnClasses = [
      "c-lane",
      "c-stage",
      "c-live",
      "c-log",
      "c-pr",
      "c-gate",
      "c-find",
    ];
    const headerCells = Array.from(doc.querySelectorAll("thead th"));
    expect(headerCells.map((th) => th.className)).toEqual(columnClasses);

    const row = doc.querySelector("tr.lane");
    expect(row).not.toBeNull();
    const cells = Array.from(row!.querySelectorAll("td"));
    expect(cells.map((td) => td.className)).toEqual(columnClasses);
  });

  test("a pill renders per state with the right variant, and its accessible text is the state — not colour alone", async () => {
    // One lane per pill tone this table can show: stage (info/bad/ok as a
    // dotted pill) and PR checks (dim/warn/ok/bad) — five distinct tones
    // across the two families, each carrying its state as plain text.
    const pillStatus: WaveStatus = {
      generatedAt: "now",
      waves: [
        {
          id: "P",
          lanes: [
            {
              wave: "P",
              lane: "p1",
              reported: { stage: "review", event: "started", ts: "now" },
              derived: {
                alive: true,
                pr: { number: 1, state: "open", checks: "pending" },
              },
              disagreements: [],
            },
            {
              wave: "P",
              lane: "p2",
              reported: { stage: "gate", event: "failed", ts: "now" },
              derived: {
                alive: false,
                pr: { number: 2, state: "open", checks: "fail" },
              },
              disagreements: [],
            },
            {
              wave: "P",
              lane: "p3",
              reported: { stage: "remediate", event: "settled", ts: "now" },
              derived: {
                alive: false,
                pr: { number: 3, state: "merged", checks: "pass" },
              },
              disagreements: [],
            },
            {
              wave: "P",
              lane: "p4",
              derived: {
                alive: false,
                pr: { number: 4, state: "merged", checks: "none" },
              },
              disagreements: [],
            },
          ],
        },
      ],
    } as WaveStatus;

    const page = await loadPage(pillStatus);
    const doc = page.window.document;
    const pills = Array.from(doc.querySelectorAll(".pill"));
    expect(pills.length).toBeGreaterThan(0);
    const byText = new Map(
      pills.map((el) => [el.textContent?.trim(), el]),
    );

    const expectTone = (text: string, tone: string) => {
      const el = byText.get(text);
      expect(el, `no pill with text "${text}"`).toBeDefined();
      expect(el!.classList.contains("pill")).toBe(true);
      expect(el!.classList.contains(tone)).toBe(true);
    };

    expectTone("started", "info");
    expectTone("failed", "bad");
    expectTone("settled", "ok");
    expectTone("pending", "warn");
    expectTone("none", "dim");

    // Every pill's accessible name is the state word itself, never colour
    // alone.
    for (const el of pills) {
      expect(el.textContent?.trim().length).toBeGreaterThan(0);
    }
  });

  test("the wave band exposes eyebrow, id and an outcome rollup inside the accordion button, and aria-controls resolves to that wave's own lane rows", async () => {
    const page = await loadPage(mixedStatus);
    const doc = page.window.document;
    const waveT = doc.querySelector(
      'tr.wave[data-wave="T"]',
    ) as unknown as HTMLElement;
    const button = waveT.querySelector("button.wave-band");
    expect(button).not.toBeNull();
    expect(button!.querySelector(".wave-eyebrow")?.textContent).toBe("wave");
    expect(button!.querySelector(".wave-id")?.textContent).toBe("T");
    const meta = button!.querySelector(".wave-meta")?.textContent ?? "";
    expect(meta).toContain("4 lanes");
    expect(meta).toContain("1 running");
    expect(meta).toContain("1 settled");
    expect(meta).toContain("1 failed");

    const controlsId = button!.getAttribute("aria-controls");
    expect(controlsId).toBeTruthy();
    const target = doc.getElementById(controlsId!);
    expect(target).not.toBeNull();
    expect(target!.tagName).toBe("TBODY");
    expect(target!.querySelectorAll('tr.lane[data-wave="T"]').length).toBe(4);

    // Still a real accordion button: collapses and expands.
    expect(button!.getAttribute("aria-expanded")).toBe("false");
    waveT.click();
    expect(button!.getAttribute("aria-expanded")).toBe("true");
    for (const lane of doc.querySelectorAll('tr.lane[data-wave="T"]')) {
      expect((lane as unknown as HTMLElement).hidden).toBe(false);
    }
    waveT.click();
    expect(button!.getAttribute("aria-expanded")).toBe("false");
  });

  test("the open lane's row carries .active, survives a re-render, and clears on close", async () => {
    const page = await loadPage(mixedStatus);
    const doc = page.window.document;
    (
      doc.querySelector('tr.wave[data-wave="T"]') as unknown as HTMLElement
    ).click();

    const row = doc.querySelector(
      'tr.lane[data-wave="T"][data-lane="t1"]',
    ) as unknown as HTMLElement;
    row.click();
    await vi.waitFor(() => {
      expect(page.fetches).toContain("/api/log/T/t1?tail=16");
    });
    expect(row.classList.contains("active")).toBe(true);
    // A different lane in the same wave never carries it.
    const other = doc.querySelector(
      'tr.lane[data-wave="T"][data-lane="t2"]',
    ) as unknown as HTMLElement;
    expect(other.classList.contains("active")).toBe(false);

    page.source.emit("status", JSON.stringify(mixedStatus));
    const reRendered = doc.querySelector(
      'tr.lane[data-wave="T"][data-lane="t1"]',
    ) as unknown as HTMLElement;
    expect(reRendered).not.toBe(row);
    expect(reRendered.classList.contains("active")).toBe(true);

    (
      doc.getElementById("log-close") as unknown as HTMLElement
    ).click();
    const afterClose = doc.querySelector(
      'tr.lane[data-wave="T"][data-lane="t1"]',
    ) as unknown as HTMLElement;
    expect(afterClose.classList.contains("active")).toBe(false);
  });

  test("with no waves at all, the table shows a single empty row instead of nothing", async () => {
    const page = await loadPage(mixedStatus);
    const doc = page.window.document;
    expect(doc.querySelectorAll("tr.wave").length).toBeGreaterThan(0);

    page.source.emit(
      "status",
      JSON.stringify({ generatedAt: "now", waves: [] }),
    );

    expect(doc.querySelectorAll("tr.wave").length).toBe(0);
    expect(doc.querySelectorAll("tr.lane").length).toBe(0);
    const emptyRows = doc.querySelectorAll("tr.empty");
    expect(emptyRows.length).toBe(1);
    expect(emptyRows[0]?.textContent).toMatch(/no waves/i);
  });

  test("every semantic column keeps its header treatment distinct from its own body cells", async () => {
    const page = await loadPage(mixedStatus);
    const doc = page.window.document;
    (
      doc.querySelector('tr.wave[data-wave="T"]') as unknown as HTMLElement
    ).click();

    const bodyRow = doc.querySelector('tr.lane[data-wave="T"][data-lane="t1"]');
    expect(bodyRow).not.toBeNull();

    // All seven semantic column classes the header and body share — a
    // body-cell rule scoped only to its own class (no tbody/td qualifier)
    // beats `thead th` on specificity and repaints that one heading as a
    // body cell, regardless of source order. Checking every column, not
    // just the ones already known to collide, catches a future column that
    // repeats the same unscoped shape.
    const columns = [
      "c-lane",
      "c-stage",
      "c-live",
      "c-log",
      "c-pr",
      "c-gate",
      "c-find",
    ];

    for (const cls of columns) {
      const th = doc.querySelector(`thead th.${cls}`);
      const td = bodyRow?.querySelector(`td.${cls}`);
      // toBeTruthy, not toBeNull: bodyRow?.querySelector() yields undefined
      // (not null) when bodyRow itself is null, and undefined would pass a
      // not-toBeNull check without either cell ever being found.
      expect(th).toBeTruthy();
      expect(td).toBeTruthy();

      const headerSize = page.window.getComputedStyle(th!).fontSize;
      const bodySize = page.window.getComputedStyle(td!).fontSize;
      // The header keeps its own 10px treatment no matter which column it
      // is, and a body cell in the same column must never resolve to that
      // same size — if it does, a body-cell rule has won specificity over
      // thead th and the heading is rendering as a body cell.
      expect(headerSize).toBe("10px");
      expect(bodySize).not.toBe(headerSize);
    }
  });

  test("typing narrows the rows; clearing restores them; a wave with no surviving lanes says so; the open log survives a filter that hides its row", async () => {
    const page = await loadPage(mixedStatus);
    const doc = page.window.document;
    const filter = doc.getElementById("filter") as unknown as HTMLInputElement;
    expect(filter).not.toBeNull();

    const dispatchInput = () => {
      const event = new (
        filter.ownerDocument!.defaultView as unknown as { Event: typeof Event }
      ).Event("input", { bubbles: true });
      filter.dispatchEvent(event);
    };

    // Initially all 5 lanes from mixedStatus (4 in T, 1 in U)
    expect(doc.querySelectorAll("tr.lane").length).toBe(5);

    // Filter to "t1" — only lane t1 matches.
    filter.value = "t1";
    dispatchInput();

    const surviving = doc.querySelectorAll("tr.lane");
    expect(surviving.length).toBe(1);
    expect(surviving[0]?.getAttribute("data-lane")).toBe("t1");

    // Wave U has no surviving lanes and says so
    const emptyU = doc.querySelector('tr.empty[data-wave="U"]');
    expect(emptyU).not.toBeNull();
    expect(emptyU?.textContent).toContain("No lanes match “t1”");

    // Open log for t1
    (surviving[0] as unknown as HTMLElement).click();
    await vi.waitFor(() => {
      expect(page.fetches).toContain("/api/log/T/t1?tail=16");
    });
    const logPane = doc.getElementById("log-pane") as unknown as HTMLElement;
    expect(logPane?.hidden).toBe(false);
    expect(doc.getElementById("log-lane")?.textContent).toBe("T/t1");

    // Now type a filter that hides t1 (e.g. "u1")
    filter.value = "u1";
    dispatchInput();

    expect(doc.querySelectorAll("tr.lane").length).toBe(1);
    expect(
      doc.querySelector('tr.lane[data-wave="T"][data-lane="t1"]'),
    ).toBeNull();
    // Wave T now has no surviving lanes
    const emptyT = doc.querySelector('tr.empty[data-wave="T"]');
    expect(emptyT).not.toBeNull();
    expect(emptyT?.textContent).toContain("No lanes match “u1”");

    // Open log pane survives even though t1 is hidden
    expect(logPane?.hidden).toBe(false);
    expect(doc.getElementById("log-lane")?.textContent).toBe("T/t1");

    // Clearing restores all rows and the active row indicator
    filter.value = "";
    dispatchInput();
    expect(doc.querySelectorAll("tr.lane").length).toBe(5);
    const restoredT1 = doc.querySelector(
      'tr.lane[data-wave="T"][data-lane="t1"]',
    );
    expect(restoredT1?.classList.contains("active")).toBe(true);
    expect(logPane?.hidden).toBe(false);
  });

  test("the filter input resolves its border to the control token and carries an accessible name", async () => {
    const page = await loadPage(mixedStatus);
    const doc = page.window.document;
    const filter = doc.getElementById("filter");
    expect(filter).not.toBeNull();
    expect(filter?.getAttribute("type")).toBe("search");
    const label = filter?.getAttribute("aria-label");
    expect(label).toBe("Filter lanes by wave or lane");

    const filterBorder = page.window.getComputedStyle(filter!).borderColor;
    const expectedBorder = page.window
      .getComputedStyle(doc.documentElement)
      .getPropertyValue("--color-border-control")
      .trim();
    expect(filterBorder).toBe(expectedBorder);

    // Verify searching by wave id and lane name
    const filterInput = filter as unknown as HTMLInputElement;
    filterInput.value = "U";
    filterInput.dispatchEvent(
      new (doc.defaultView as unknown as { Event: typeof Event }).Event("input", {
        bubbles: true,
      }),
    );
    expect(doc.querySelectorAll("tr.lane").length).toBe(1);
    expect(doc.querySelector("tr.lane")?.getAttribute("data-wave")).toBe("U");

    filterInput.value = "t2";
    filterInput.dispatchEvent(
      new (doc.defaultView as unknown as { Event: typeof Event }).Event("input", {
        bubbles: true,
      }),
    );
    expect(doc.querySelectorAll("tr.lane").length).toBe(1);
    expect(doc.querySelector("tr.lane")?.getAttribute("data-lane")).toBe("t2");
  });

  test("filtering with every wave collapsed displays the no-match empty row rather than hiding it", async () => {
    const page = await loadPage(mixedStatus);
    const doc = page.window.document;
    const filter = doc.getElementById("filter") as unknown as HTMLInputElement;

    const dispatchInput = () => {
      const event = new (
        filter.ownerDocument!.defaultView as unknown as { Event: typeof Event }
      ).Event("input", { bubbles: true });
      filter.dispatchEvent(event);
    };

    // Verify every wave is collapsed initially (page opens with defaultExpanded = false)
    const waveButtons = Array.from(doc.querySelectorAll("tr.wave button"));
    expect(waveButtons.length).toBeGreaterThan(0);
    for (const btn of waveButtons) {
      expect(btn.getAttribute("aria-expanded")).toBe("false");
    }
    const allLanes = Array.from(doc.querySelectorAll("tr.lane"));
    for (const lane of allLanes) {
      expect((lane as unknown as HTMLElement).hidden).toBe(true);
    }

    // Filter to "t1" — Wave U has no matching lanes.
    filter.value = "t1";
    dispatchInput();

    const emptyU = doc.querySelector('tr.empty[data-wave="U"]') as unknown as HTMLElement;
    expect(emptyU).not.toBeNull();
    expect(emptyU.hidden).toBe(false);
    expect(emptyU.textContent).toContain("No lanes match “t1”");

    // Filter to a query that matches no lane in any wave
    filter.value = "nomatchanywhere";
    dispatchInput();

    const emptyRows = Array.from(doc.querySelectorAll("tr.empty"));
    expect(emptyRows.length).toBe(2);
    for (const row of emptyRows) {
      expect((row as unknown as HTMLElement).hidden).toBe(false);
      expect(row.textContent).toContain("No lanes match “nomatchanywhere”");
    }

    // Toggling the wave open and closed keeps the empty row visible
    const waveUButton = doc.querySelector('tr.wave[data-wave="U"] button') as unknown as HTMLElement;
    waveUButton.click();
    expect(waveUButton.getAttribute("aria-expanded")).toBe("true");
    expect((doc.querySelector('tr.empty[data-wave="U"]') as unknown as HTMLElement).hidden).toBe(false);

    waveUButton.click();
    expect(waveUButton.getAttribute("aria-expanded")).toBe("false");
    expect((doc.querySelector('tr.empty[data-wave="U"]') as unknown as HTMLElement).hidden).toBe(false);
  });

  test("typing in the filter does not refetch the followed log", async () => {
    let logCalls = 0;
    const page = await loadPage(mixedStatus, () => {
      logCalls++;
      return new Response("log output", { status: 200 });
    });
    const doc = page.window.document;

    // Open log for T/t1
    const laneT1 = doc.querySelector('tr.lane[data-wave="T"][data-lane="t1"]') as unknown as HTMLElement;
    laneT1.click();
    await vi.waitFor(() => {
      expect(page.fetches).toContain("/api/log/T/t1?tail=16");
    });
    const initialFetches = page.fetches.length;

    // Enable follow
    const followCheckbox = doc.getElementById("log-follow") as unknown as HTMLInputElement;
    followCheckbox.checked = true;
    followCheckbox.dispatchEvent(
      new (followCheckbox.ownerDocument!.defaultView as unknown as { Event: typeof Event }).Event("change", {
        bubbles: true,
      }),
    );
    await vi.waitFor(() => {
      expect(page.fetches.length).toBeGreaterThan(initialFetches);
    });
    const followFetches = page.fetches.length;

    // Type multiple characters into filter
    const filter = doc.getElementById("filter") as unknown as HTMLInputElement;
    filter.value = "t";
    filter.dispatchEvent(
      new (filter.ownerDocument!.defaultView as unknown as { Event: typeof Event }).Event("input", {
        bubbles: true,
      }),
    );
    filter.value = "t1";
    filter.dispatchEvent(
      new (filter.ownerDocument!.defaultView as unknown as { Event: typeof Event }).Event("input", {
        bubbles: true,
      }),
    );

    // Give any microtasks/promises a turn
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Filter typing must not have triggered additional log tail fetches
    expect(page.fetches.length).toBe(followFetches);
  });

  test("a referenced token that resolves to empty raises the warning naming it; a fully-resolving page shows nothing", async () => {
    // Fully resolving page shows nothing
    const normalPage = await loadPage(mixedStatus);
    const normalWarning = normalPage.window.document.getElementById(
      "palette-warning",
    ) as unknown as HTMLElement;
    expect(normalWarning?.hidden).toBe(true);

    // Broken tokens: omit --color-brand-primary
    const raw = await readFile(realTokensPath, "utf8");
    const root = extractRootBlock(raw) ?? "";
    const dark = extractDarkBlock(raw) ?? "";
    const brokenCss = `${root}\n\n${dark}\n`.replaceAll(
      "--color-brand-primary",
      "--color-brand-primary-omitted",
    );
    const brokenPage = await loadPage(mixedStatus, undefined, {
      tokensCss: brokenCss,
    });
    const brokenWarning = brokenPage.window.document.getElementById(
      "palette-warning",
    ) as unknown as HTMLElement;
    expect(brokenWarning?.hidden).toBe(false);
    expect(brokenWarning?.textContent).toContain("--color-brand-primary");
  });
});
