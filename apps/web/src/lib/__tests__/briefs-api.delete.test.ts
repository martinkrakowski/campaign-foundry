import { describe, test, expect, vi } from "vitest";
import { API } from "@/lib/run-context";
import { BriefsApiError, deleteCampaign } from "../briefs-api";
import { NoMembershipError } from "../auth-errors";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const mockFetch = (
  handler: (url: string, init: RequestInit) => Response | Promise<Response> | never,
) => {
  vi.mocked(globalThis.fetch).mockImplementation((url, init) =>
    Promise.resolve(handler(String(url), (init ?? {}) as RequestInit)),
  );
};

describe("deleteCampaign", () => {
  test("deleteCampaign sends DELETE to the encoded id and resolves on 202", async () => {
    let seenUrl = "";
    let seenInit: RequestInit = {};
    mockFetch((url, init) => {
      seenUrl = url;
      seenInit = init;
      return json({ deletionId: "d1" }, 202);
    });

    await expect(deleteCampaign("a b/c")).resolves.toBeUndefined();
    expect(seenUrl).toBe(`${API}/campaigns/a%20b%2Fc`);
    expect(seenInit.method).toBe("DELETE");
    expect(seenInit.body).toBeUndefined();
  });

  test("deleteCampaign resolves on any 2xx whatever the body", async () => {
    mockFetch(() => json({}, 200));
    await expect(deleteCampaign("demo")).resolves.toBeUndefined();
    mockFetch(() => new Response(null, { status: 204 }));
    await expect(deleteCampaign("demo")).resolves.toBeUndefined();
    mockFetch(
      () => new Response("not-json", { status: 202, headers: { "content-type": "text/plain" } }),
    );
    await expect(deleteCampaign("demo")).resolves.toBeUndefined();
  });

  test("deleteCampaign resolves on a 2xx whose body cannot be read", async () => {
    // The status line arrived, so the server has answered; the body is a stream
    // that can still fail afterwards. Nobody reads a delete's body, so a body
    // that cannot be read must not turn a finished delete into a failure.
    const text = vi.fn(() => Promise.reject(new Error("stream closed")));
    mockFetch(() => ({ ok: true, status: 202, text }) as unknown as Response);

    await expect(deleteCampaign("demo")).resolves.toBeUndefined();
    expect(text).not.toHaveBeenCalled();
  });

  test("deleteCampaign resolves on a 2xx whose body cannot even be cancelled", async () => {
    // The unread body is cancelled, best effort: a stream that is locked or
    // already errored rejects the cancel, and that rejection is nobody's
    // failure either. It must be swallowed, not left unhandled.
    const cancel = vi.fn(() => Promise.reject(new Error("locked")));
    mockFetch(() => ({ ok: true, status: 200, body: { cancel } }) as unknown as Response);

    await expect(deleteCampaign("demo")).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test("deleteCampaign maps each failure status to a BriefsApiError carrying that status", async () => {
    for (const status of [400, 403, 404, 409, 501]) {
      const body =
        status === 409 ? { error: `msg-${status}`, jobId: "j1" } : { error: `msg-${status}` };
      mockFetch(() => json(body, status));
      const err = await deleteCampaign("demo").catch((e: unknown) => e);
      expect(err).toMatchObject({ name: "BriefsApiError", status, message: `msg-${status}` });
      // A failure never carries a revision: only a 409 conflict body can carry one, and
      // the delete route's 409 has no `revision` field to read.
      expect((err as BriefsApiError).revision).toBeUndefined();
    }
  });

  test("deleteCampaign keeps a plain 403 as a BriefsApiError and not a membership error", async () => {
    mockFetch(() => json({ error: "no" }, 403));
    await expect(deleteCampaign("demo")).rejects.toSatisfy(
      (err: unknown) => err instanceof BriefsApiError && err instanceof NoMembershipError === false,
    );
  });

  test("deleteCampaign throws NoMembershipError for a 403 with the no_membership code", async () => {
    mockFetch(() =>
      json({ error: "This account belongs to no organisation.", code: "no_membership" }, 403),
    );
    await expect(deleteCampaign("demo")).rejects.toBeInstanceOf(NoMembershipError);
  });

  test("deleteCampaign wraps a network failure", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new TypeError("boom"));
    await expect(deleteCampaign("demo")).rejects.toMatchObject({
      status: 0,
      message: "Network error",
    });
  });
});
