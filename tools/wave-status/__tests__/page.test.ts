import { afterEach, describe, expect, test, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import type { WaveStatus } from "../lib/types.js";

const PAGE_PATH = fileURLToPath(
  new URL("../public/index.html", import.meta.url),
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
    "window",
    scriptMatch[1],
  ) as (
    document: Document,
    fetch: typeof globalThis.fetch,
    EventSource: typeof FakeEventSource,
    setIntervalFn: (handler: () => void, ms?: number) => number,
    clearIntervalFn: (id: number) => void,
    window: Window,
  ) => void;

  run(
    window.document as unknown as Document,
    fetchImpl,
    FakeEventSource,
    setIntervalImpl,
    clearIntervalImpl,
    window,
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
    const logView = page.window.document.getElementById(
      "log",
    ) as HTMLElement | null;
    await vi.waitFor(() => {
      expect(page.fetches).toContain("/api/log/T/t1?tail=16");
      expect(logView?.hidden).toBe(false);
      expect(logView?.textContent).toContain("log-tail");
    });

    page.fetches.length = 0;
    if (logView !== null) logView.textContent = "";
    row?.dispatchEvent(
      new page.window.KeyboardEvent("keydown", { key: " ", bubbles: true }),
    );
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
    row?.dispatchEvent(
      new page.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
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

  test("the toolbar renders each control with an accessible name, and the lane name and byte size", async () => {
    const page = await loadPage(statusAt(), "log-tail");
    const doc = page.window.document;
    const row = doc.querySelector("tr.lane");
    row?.dispatchEvent(
      new page.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await vi.waitFor(() => {
      expect(
        (doc.getElementById("log-pane") as HTMLElement | null)?.hidden,
      ).toBe(false);
    });

    const toolbar = doc.getElementById("log-toolbar");
    expect(toolbar).not.toBeNull();
    expect(doc.getElementById("log-lane")?.textContent?.trim()).toBe("T/t1");
    expect(doc.getElementById("log-size")?.textContent?.trim()).toBe("8 B");

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
    row?.dispatchEvent(
      new page.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
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

  test("copy writes the body text without line numbers — assert the clipboard payload", async () => {
    const multiline = "first line\nsecond line\nthird line";
    const page = await loadPage(statusAt(), multiline);
    const doc = page.window.document;
    const row = doc.querySelector("tr.lane");
    row?.dispatchEvent(
      new page.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await vi.waitFor(() => {
      expect(
        (doc.getElementById("log-pane") as HTMLElement | null)?.hidden,
      ).toBe(false);
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

  test("the gutter is user-select: none, and the number of gutter entries equals the line count", async () => {
    const multiline = "alpha\nbeta\ngamma\ndelta";
    const lineCount = 4;
    const page = await loadPage(statusAt(), multiline);
    const doc = page.window.document;
    const row = doc.querySelector("tr.lane");
    row?.dispatchEvent(
      new page.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await vi.waitFor(() => {
      expect(
        (doc.getElementById("log-pane") as HTMLElement | null)?.hidden,
      ).toBe(false);
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
    rows[0]?.dispatchEvent(
      new page.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );

    // 2. Start opening lane T/t2 before T/t1 resolves
    rows[1]?.dispatchEvent(
      new page.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );

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

  test("copy reports failure and does not claim success when clipboard API is absent or writeText rejects", async () => {
    const page = await loadPage(statusAt(), "sample log");
    const doc = page.window.document;
    const row = doc.querySelector("tr.lane");
    row?.dispatchEvent(
      new page.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
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
    row?.dispatchEvent(
      new page.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await vi.waitFor(() => {
      expect(
        (doc.getElementById("log-pane") as HTMLElement | null)?.hidden,
      ).toBe(false);
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
    row?.dispatchEvent(
      new page.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );

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
    row?.dispatchEvent(
      new page.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
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
    rows[0]?.dispatchEvent(
      new page.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
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
    rows[1]?.dispatchEvent(
      new page.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
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
      expect(waveRow.getAttribute("aria-expanded")).toBe("false");
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

    // Open wave
    waveRow.click();
    expect(waveRow.getAttribute("aria-expanded")).toBe("true");
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
    expect(waveRow.getAttribute("aria-expanded")).toBe("false");
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

  test("the wave row is reachable by keyboard and carries aria-expanded in both states", async () => {
    const page = await loadPage(statusAt());
    const doc = page.window.document;
    const waveRow = doc.querySelector("tr.wave") as unknown as HTMLElement;
    expect(waveRow).not.toBeNull();
    expect(waveRow.getAttribute("role")).toBe("button");
    expect(waveRow.getAttribute("tabindex")).toBe("0");
    expect(waveRow.getAttribute("aria-expanded")).toBe("false");

    waveRow.dispatchEvent(
      new page.window.KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
      }) as unknown as Event,
    );
    expect(waveRow.getAttribute("aria-expanded")).toBe("true");

    waveRow.dispatchEvent(
      new page.window.KeyboardEvent("keydown", {
        key: " ",
        bubbles: true,
      }) as unknown as Event,
    );
    expect(waveRow.getAttribute("aria-expanded")).toBe("false");
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
    expect(waveT.getAttribute("aria-expanded")).toBe("true");
    expect(waveU.getAttribute("aria-expanded")).toBe("false");

    // Re-render via SSE status event
    page.source.emit("status", JSON.stringify(mixedStatus));

    const updatedWaveRows = doc.querySelectorAll("tr.wave");
    const updatedWaveT = updatedWaveRows[0] as unknown as HTMLElement;
    const updatedWaveU = updatedWaveRows[1] as unknown as HTMLElement;

    expect(updatedWaveT.getAttribute("aria-expanded")).toBe("true");
    expect(updatedWaveU.getAttribute("aria-expanded")).toBe("false");

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

  test("a re-render leaves the focused wave row focused, and a vanished row gets nothing back", async () => {
    const page = await loadPage(mixedStatus);
    const doc = page.window.document;
    const waveT = doc.querySelector(
      'tr.wave[data-wave="T"]',
    ) as unknown as HTMLElement;
    waveT.focus();
    expect(doc.activeElement).toBe(waveT);

    page.source.emit("status", JSON.stringify(mixedStatus));
    const reRendered = doc.querySelector(
      'tr.wave[data-wave="T"]',
    ) as unknown as HTMLElement;
    expect(reRendered).not.toBe(waveT);
    expect(doc.activeElement).toBe(reRendered);

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
    hot.focus();
    expect(doc.activeElement).toBe(hot);
    expect(
      (doc.querySelectorAll("tr.lane")[0] as unknown as HTMLElement).dataset
        .lane,
    ).toBe("l_hot");

    page.source.emit("status", JSON.stringify(after));
    const hotAgain = doc.querySelector(
      'tr.lane[data-lane="l_hot"]',
    ) as unknown as HTMLElement;
    expect(hotAgain).not.toBe(hot);
    expect(doc.activeElement).toBe(hotAgain);
  });

  test("each wave control names the one element that holds its rows, and the names are unique", async () => {
    const page = await loadPage(mixedStatus);
    const doc = page.window.document;
    const waveRows = Array.from(doc.querySelectorAll("tr.wave"));
    expect(waveRows.length).toBe(2);

    const seen = new Set<string>();
    for (const waveRow of waveRows) {
      const control = waveRow.getAttribute("aria-controls");
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
});
