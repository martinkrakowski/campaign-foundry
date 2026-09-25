import { describe, test, expect, vi } from "vitest";
import { LogMailer } from "../log-mailer.js";

describe("LogMailer (PT-1a item 8: used without a key)", () => {
  test("logs instead of sending", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const mailer = new LogMailer();

    await mailer.send({ to: "person@example.com", subject: "Sign in", html: "<p>hi</p>" });

    expect(logSpy).toHaveBeenCalledWith(
      "[auth] no RESEND_API_KEY set — would send to person@example.com: Sign in",
    );
    logSpy.mockRestore();
  });
});
