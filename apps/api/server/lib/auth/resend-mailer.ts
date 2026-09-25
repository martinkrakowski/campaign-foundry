import type { Mail, MailerPort } from "./mailer.port.js";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * Mail over Resend's HTTP API (D174b(3), stamped 2026-09-25): `fetch` only, no
 * SDK, so no dependency beyond `better-auth` itself joins this lane. A non-2xx
 * response throws with Resend's own error body, so a broken key or an
 * unverified sending domain fails loudly instead of a silently undelivered
 * magic link.
 */
export class ResendMailer implements MailerPort {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(mail: Mail): Promise<void> {
    const response = await this.fetchImpl(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.from,
        to: mail.to,
        subject: mail.subject,
        html: mail.html,
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Resend refused the email (${response.status}): ${body || response.statusText}`);
    }
  }
}
