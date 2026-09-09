import { afterEach, describe, expect, test, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import type { WaveStatus } from "../lib/types.js";

const PAGE_PATH = fileURLToPath(new URL("../public/index.html", import.meta.url));

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  readonly url: string;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(_type: string, _listener: (event: { data: string }) => void): void {
    /* tests drive onerror; status events are not needed here */
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
}

const windows: Window[] = [];

afterEach(() => {
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
const mixedStatus: WaveStatus =
  {
    generatedAt: "now",
    waves: [
      {
        id: "T",
        lanes: [
          {
            wave: "T",
            lane: "t1",
            reported: { stage: "remediate", event: "settled", ts: "now" },
            derived: { alive: true, pr: { number: 1, state: "open", checks: "pass" } },
            disagreements: [],
          },
          {
            wave: "T",
            lane: "t2",
            reported: { stage: "gate", event: "failed", ts: "now" },
            derived: { alive: false, pr: { number: 2, state: "open", checks: "fail" } },
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
            derived: { alive: false, pr: { number: 3, state: "merged", checks: "none" } },
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
            derived: { alive: false, pr: { number: 4, state: "merged", checks: "pass" } },
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

async function loadPage(status: WaveStatus, logText = "log-tail"): Promise<PageHandle> {
  const html = await readFile(PAGE_PATH, "utf8");
  const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (scriptMatch === null) throw new Error("page has no script");

  const window = new Window({ url: "http://127.0.0.1/" });
  windows.push(window);
  window.document.write(html.replace(/<script>[\s\S]*?<\/script>/, ""));

  const fetches: string[] = [];
  const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    fetches.push(url);
    if (url.startsWith("/api/status")) {
      return new Response(JSON.stringify(status), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith("/api/log/")) {
      return new Response(logText, { status: 200, headers: { "content-type": "text/plain" } });
    }
    return new Response("not found", { status: 404 });
  };

  const intervals = new Set<number>();
  let nextId = 1;
  const setIntervalImpl = (handler: () => void): number => {
    void handler;
    const id = nextId++;
    intervals.add(id);
    return id;
  };
  const clearIntervalImpl = (id: number): void => {
    intervals.delete(id);
  };

  const run = new Function(
    "document",
    "fetch",
    "EventSource",
    "setInterval",
    "clearInterval",
    scriptMatch[1],
  ) as (
    document: Document,
    fetch: typeof globalThis.fetch,
    EventSource: typeof FakeEventSource,
    setIntervalFn: (handler: () => void, ms?: number) => number,
    clearIntervalFn: (id: number) => void,
  ) => void;

  run(
    window.document as unknown as Document,
    fetchImpl,
    FakeEventSource,
    setIntervalImpl,
    clearIntervalImpl,
  );

  await vi.waitFor(() => {
    expect(window.document.querySelector("tr.lane")).not.toBeNull();
  });

  const source = FakeEventSource.instances[0];
  if (source === undefined) throw new Error("EventSource was not constructed");

  return { window, fetches, intervals, source };
}

describe("the status page", () => {
  test("Enter or Space on a lane row fetches the log", async () => {
    const page = await loadPage(statusAt());
    const row = page.window.document.querySelector("tr.lane");
    expect(row).not.toBeNull();
    expect(row?.getAttribute("role")).toBe("button");
    expect(row?.getAttribute("tabindex")).toBe("0");

    row?.dispatchEvent(
      new page.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    const logView = page.window.document.getElementById("log") as HTMLElement | null;
    await vi.waitFor(() => {
      expect(page.fetches).toContain("/api/log/T/t1?tail=16");
      expect(logView?.hidden).toBe(false);
      expect(logView?.textContent).toContain("log-tail");
    });

    page.fetches.length = 0;
    if (logView !== null) logView.textContent = "";
    row?.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    await vi.waitFor(() => {
      expect(page.fetches).toContain("/api/log/T/t1?tail=16");
      expect(logView?.textContent).toContain("log-tail");
    });
  });

  test("a second SSE drop does not stack polling intervals", async () => {
    const page = await loadPage(statusAt());
    page.source.onerror?.();
    page.source.onerror?.();
    expect(page.intervals.size).toBe(1);
  });

  test("a detail value of <b> renders as text, not markup", async () => {
    const page = await loadPage(
      statusAt({ fixed: "<b>", refuted: "<img>", mutations: "</td>", mutationsBit: "<i>" }),
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
    expect(doc.querySelector('[data-metric="open"] .value')?.textContent).toBe("2");
    expect(doc.querySelector('[data-metric="merged"] .value')?.textContent).toBe("2");
    expect(doc.querySelector('[data-metric="lanes"] .value')?.textContent).toBe("5");
  });

  test("an unknown metric renders —, never 0", async () => {
    // statusAt(): one lane, no reported events, no PR — nothing is known
    // about outcomes or PRs, and the header must say so.
    const page = await loadPage(statusAt());
    const doc = page.window.document;
    for (const name of ["settled", "failed", "running", "open", "merged", "failing"]) {
      expect(doc.querySelector(`[data-metric="${name}"] .value`)?.textContent).toBe("—");
    }
    // The structural counts are known the moment a status arrives; a known
    // zero (all lanes not alive) is a real answer, unlike an unknown one.
    expect(doc.querySelector('[data-metric="lanes"] .value')?.textContent).toBe("1");
    expect(doc.querySelector('[data-metric="alive"] .value')?.textContent).toBe("0");
    expect(doc.querySelector('[data-metric="waves"] .value')?.textContent).toBe("1");
  });

  test("the container declares two grid rows and the log pane is hidden with no log open", async () => {
    const page = await loadPage(statusAt());
    const html = await readFile(PAGE_PATH, "utf8");
    const style = await pageStyle();
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
    // Two rows with no log open, three with one — the grid sizes both panes;
    // JavaScript only flips the state, it must never listen for resizes.
    expect(style).toMatch(/#page\s*\{[^}]*grid-template-rows:\s*auto 1fr\s*;/);
    expect(style).toMatch(/#page\.with-log\s*\{[^}]*grid-template-rows:\s*auto 1fr 1fr\s*;/);
    expect(style).not.toMatch(/max-height:\s*40vh/);
    expect(script).not.toMatch(/addEventListener\(\s*["']resize["']|onresize\s*=/);
    const logView = page.window.document.getElementById("log") as HTMLElement | null;
    expect(logView?.hidden).toBe(true);
  });

  test("opening a log reveals the second row; closing it returns the table to full height", async () => {
    const page = await loadPage(statusAt());
    const doc = page.window.document;
    const container = doc.getElementById("page");
    const logView = doc.getElementById("log") as HTMLElement | null;
    expect(container?.classList.contains("with-log")).toBe(false);
    expect(logView?.hidden).toBe(true);

    const row = doc.querySelector("tr.lane");
    row?.dispatchEvent(
      new page.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await vi.waitFor(() => {
      expect(page.fetches).toContain("/api/log/T/t1?tail=16");
      expect(logView?.hidden).toBe(false);
      expect(container?.classList.contains("with-log")).toBe(true);
    });

    logView?.dispatchEvent(new page.window.Event("click", { bubbles: true }) as unknown as Event);
    expect(logView?.hidden).toBe(true);
    expect(container?.classList.contains("with-log")).toBe(false);
  });

  test("the page still declares no --color-* custom property of its own", async () => {
    const style = await pageStyle();
    expect(style).toMatch(/var\(--color-/); // tokens are consumed, from /tokens.css
    expect(style).not.toMatch(/--color-[\w-]+\s*:/);
  });
});
