import type { Mail, MailerPort } from "./mailer.port.js";

/**
 * The mailer when no `RESEND_API_KEY` is configured: logs instead of sending,
 * including the sign-in URL from the email HTML so developers/operators can
 * complete sign-in in development (Finding 7).
 */
export class LogMailer implements MailerPort {
  async send(mail: Mail): Promise<void> {
    const match = /href=["']([^"']+)["']/.exec(mail.html);
    const url = match ? match[1] : undefined;
    if (url) {
      console.log(`[auth] RESEND_API_KEY not set — sign-in link for ${mail.to}: ${url}`);
    } else {
      console.log(`[auth] RESEND_API_KEY not set — would send to ${mail.to}: ${mail.subject}`);
    }
  }
}
