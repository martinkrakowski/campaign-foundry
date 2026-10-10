import { describe, expect, test, vi } from "vitest";
import type { AssetStorePort } from "../../ports/asset-store.port.js";
import { writeOrReuse } from "../asset-step.js";
import { PNG } from "./fixtures/tree.js";

const KEY = "org/o/campaign/c/inputs/id-1";

function stub(
  writeAsset: ReturnType<typeof vi.fn>,
  readAsset: ReturnType<typeof vi.fn>,
  listAssets: ReturnType<typeof vi.fn>,
  assetObjectKey: ReturnType<typeof vi.fn>,
): AssetStorePort {
  return { writeAsset, readAsset, listAssets, assetObjectKey } as unknown as AssetStorePort;
}

describe("writeOrReuse: object key source", () => {
  test("a newly written asset's key comes from the write, not from a second lookup", async () => {
    const assetObjectKey = vi.fn().mockRejectedValue(new Error("assetObjectKey must not run on a fresh write"));
    const assets = stub(
      vi.fn().mockResolvedValue({ path: "assets/inputs/camp/a.png", id: "id-1", objectKey: KEY }),
      vi.fn(),
      vi.fn(),
      assetObjectKey,
    );
    const out = await writeOrReuse(assets, "camp", "a.png", PNG, "camp");
    expect(out).toEqual({ id: "id-1", name: "a.png", key: KEY, reused: false });
    expect(assetObjectKey).not.toHaveBeenCalled();
  });

  test("a reused asset's key still comes from the lookup", async () => {
    const eexist: Error & { code: string } = Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    const assetObjectKey = vi.fn().mockResolvedValue(KEY);
    const assets = stub(
      vi.fn().mockRejectedValue(eexist),
      vi.fn().mockResolvedValue(PNG),
      vi.fn().mockResolvedValue([
        { name: "a.png", type: "png", size: PNG.length, thumbnailUrl: "", id: "id-1" },
      ]),
      assetObjectKey,
    );
    const out = await writeOrReuse(assets, "camp", "a.png", PNG, "camp");
    expect(out).toEqual({ id: "id-1", name: "a.png", key: KEY, reused: true });
    expect(assetObjectKey).toHaveBeenCalledTimes(1);
  });
});
