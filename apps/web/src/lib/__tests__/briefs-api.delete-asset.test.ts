import { describe, test, expect, vi } from "vitest";
import { API } from "@/lib/run-context";
import { BriefsApiError, deleteAsset, listAssets } from "../briefs-api";
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

const ID = "11111111-2222-4333-8444-555555555555";

describe("deleteAsset", () => {
  test("deleteAsset sends DELETE with the briefId and the asset id when the entry has one", async () => {
    let seenUrl = "";
    let seenInit: RequestInit = {};
    mockFetch((url, init) => {
      seenUrl = url;
      seenInit = init;
      return json({ deleted: true }, 200);
    });

    await expect(deleteAsset("camp-1", { id: ID, name: "logo.png" })).resolves.toBeUndefined();
    expect(seenUrl).toBe(`${API}/campaigns/assets?briefId=camp-1&id=${ID}`);
    expect(seenInit.method).toBe("DELETE");
    expect(seenInit.body).toBeUndefined();
    expect(seenUrl).not.toContain("name=");
  });

  test("deleteAsset sends the name when the entry has no id", async () => {
    let seenUrl = "";
    mockFetch((url) => {
      seenUrl = url;
      return json({ deleted: true }, 200);
    });

    await deleteAsset("camp-1", { name: "logo.png" });
    expect(seenUrl).toBe(`${API}/campaigns/assets?briefId=camp-1&name=logo.png`);
    expect(seenUrl).not.toContain("id=");
  });

  test("deleteAsset sends the name when the entry id is not an asset id", async () => {
    // `ID` above is all-digits, so to exercise `isAssetId` rejecting an UPPER-case uuid
    // (asset-refs.ts:27, lowercase-only pattern) the uppercase case carries hex letters.
    const uppercaseId = "ABCDEF12-2222-4333-8444-555555555555";
    for (const asset of [
      { id: "not-a-uuid", name: "logo.png" },
      { id: uppercaseId, name: "logo.png" },
    ]) {
      let seenUrl = "";
      mockFetch((url) => {
        seenUrl = url;
        return json({ deleted: true }, 200);
      });

      await deleteAsset("camp-1", asset);
      expect(seenUrl).toBe(`${API}/campaigns/assets?briefId=camp-1&name=logo.png`);
      expect(seenUrl).not.toContain("id=");
    }
  });

  test("deleteAsset encodes the briefId and the name", async () => {
    let seenUrl = "";
    mockFetch((url) => {
      seenUrl = url;
      return json({ deleted: true }, 200);
    });

    await deleteAsset("a b", { name: "x y.png" });
    expect(seenUrl).toBe(`${API}/campaigns/assets?briefId=a%20b&name=x%20y.png`);
  });

  test("deleteAsset resolves on any 2xx whatever the body", async () => {
    mockFetch(() => json({}, 200));
    await expect(deleteAsset("camp-1", { name: "logo.png" })).resolves.toBeUndefined();
    mockFetch(() => new Response(null, { status: 204 }));
    await expect(deleteAsset("camp-1", { name: "logo.png" })).resolves.toBeUndefined();
    mockFetch(
      () => new Response("not-json", { status: 202, headers: { "content-type": "text/plain" } }),
    );
    await expect(deleteAsset("camp-1", { name: "logo.png" })).resolves.toBeUndefined();
  });

  test("deleteAsset maps 400 404 and 409 to a BriefsApiError carrying that status", async () => {
    for (const status of [400, 404, 409]) {
      mockFetch(() => json({ error: `msg-${status}` }, status));
      const err = await deleteAsset("camp-1", { id: ID, name: "logo.png" }).catch(
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ name: "BriefsApiError", status, message: `msg-${status}` });
    }
  });

  test("deleteAsset rejects on a 404 where listAssets would answer an empty list", async () => {
    mockFetch(() => json({ error: "x" }, 404));
    await expect(deleteAsset("camp-1", { name: "logo.png" })).rejects.toMatchObject({
      name: "BriefsApiError",
      status: 404,
    });
    // `listAssets` treats that same 404 as an empty list (it uses fetch directly, not
    // `requestJson`, which throws on 404) — pins the difference this function exists to keep.
    await expect(listAssets("camp-1")).resolves.toEqual({ assets: [] });
  });

  test("deleteAsset throws NoMembershipError for a 403 with the no_membership code", async () => {
    mockFetch(() =>
      json({ error: "This account belongs to no organisation.", code: "no_membership" }, 403),
    );
    await expect(deleteAsset("camp-1", { name: "logo.png" })).rejects.toBeInstanceOf(
      NoMembershipError,
    );

    // A plain 403 (no membership code) stays a BriefsApiError, mirroring briefs-api.delete.test.ts.
    mockFetch(() => json({ error: "no" }, 403));
    await expect(deleteAsset("camp-1", { name: "logo.png" })).rejects.toSatisfy(
      (err: unknown) => err instanceof BriefsApiError && err instanceof NoMembershipError === false,
    );
  });

  test("deleteAsset wraps a network failure", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new TypeError("boom"));
    await expect(deleteAsset("camp-1", { name: "logo.png" })).rejects.toMatchObject({
      status: 0,
      message: "Network error",
    });
  });
});
