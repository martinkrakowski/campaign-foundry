import { describe, expect, test } from "vitest";
import nextConfig from "../../next.config";

describe("next.config rewrites", () => {
  test("rewrites include /api/pipeline and /api/auth proxied to the API", async () => {
    expect(nextConfig.rewrites).toBeDefined();
    const rewrites = await nextConfig.rewrites!();
    expect(Array.isArray(rewrites)).toBe(true);
    const list = rewrites as Array<{ source: string; destination: string }>;

    expect(list).toContainEqual({
      source: "/api/pipeline/:path*",
      destination: expect.stringMatching(/:path\*$/),
    });

    expect(list).toContainEqual({
      source: "/api/auth/:path*",
      destination: expect.stringMatching(/\/api\/auth\/:path\*$/),
    });
  });
});
