import { describe, test, expect, vi } from "vitest";
import { ResendMailer } from "../resend-mailer.js";

describe("ResendMailer (PT-1a item 8, D174b(3))", () => {
  test("sends the right request to Resend's HTTP API", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const mailer = new ResendMailer("re_key", "noreply@example.com", fetchImpl);

    await mailer.send({ to: "person@example.com", subject: "Sign in", html: "<p>hi</p>" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      Authorization: "Bearer re_key",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init.body as string)).toEqual({
      from: "noreply@example.com",
      to: "person@example.com",
      subject: "Sign in",
      html: "<p>hi</p>",
    });
  });

  test("surfaces a non-2xx response", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response("domain not verified", { status: 422, statusText: "Unprocessable" }),
      );
    const mailer = new ResendMailer("re_key", "noreply@example.com", fetchImpl);

    await expect(
      mailer.send({ to: "person@example.com", subject: "Sign in", html: "<p>hi</p>" }),
    ).rejects.toThrow("Resend refused the email (422): domain not verified");
  });

  test("falls back to the status text when the error body is empty", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 500, statusText: "Server Error" }));
    const mailer = new ResendMailer("re_key", "noreply@example.com", fetchImpl);

    await expect(
      mailer.send({ to: "person@example.com", subject: "Sign in", html: "<p>hi</p>" }),
    ).rejects.toThrow("Resend refused the email (500): Server Error");
  });

  test("falls back to the status text when reading the error body itself fails", async () => {
    const broken = {
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      text: () => Promise.reject(new Error("stream closed")),
    };
    const fetchImpl = vi.fn().mockResolvedValue(broken as unknown as Response);
    const mailer = new ResendMailer("re_key", "noreply@example.com", fetchImpl);

    await expect(
      mailer.send({ to: "person@example.com", subject: "Sign in", html: "<p>hi</p>" }),
    ).rejects.toThrow("Resend refused the email (503): Service Unavailable");
  });
});
