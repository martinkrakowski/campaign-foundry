import { describe, test, expect, vi } from "vitest";
import { LogMailer } from "../log-mailer.js";

describe("LogMailer (PT-1a item 8, Finding 7)", () => {
  test("logs the sign-in URL when present in email html", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const mailer = new LogMailer();

    await mailer.send({
      to: "person@example.com",
      subject: "Sign in to Campaign Foundry",
      html: '<p>Sign in by following this link:</p><p><a href="http://127.0.0.1:3000/api/auth/verify?token=abc">http://127.0.0.1:3000/api/auth/verify?token=abc</a></p>',
    });

    expect(logSpy).toHaveBeenCalledWith(
      "[auth] RESEND_API_KEY not set — sign-in link for person@example.com: http://127.0.0.1:3000/api/auth/verify?token=abc",
    );
    logSpy.mockRestore();
  });

  test("falls back to logging recipient and subject when no link is present", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const mailer = new LogMailer();

    await mailer.send({
      to: "person@example.com",
      subject: "Sign in",
      html: "<p>no link here</p>",
    });

    expect(logSpy).toHaveBeenCalledWith(
      "[auth] RESEND_API_KEY not set — would send to person@example.com: Sign in",
    );
    logSpy.mockRestore();
  });
});
