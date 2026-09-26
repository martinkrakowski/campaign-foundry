"use client";

import { useEffect, useState, type FormEvent } from "react";
import { getCapabilities, type HostCapabilities } from "@/lib/briefs-api";
import { authClient } from "@/lib/auth-client";
import { Button, Input } from "@/components/ui";

export default function SignInPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [capabilities, setCapabilities] = useState<HostCapabilities | null>(null);

  useEffect(() => {
    let active = true;
    void getCapabilities()
      .then((caps) => {
        if (active) setCapabilities(caps);
      })
      .catch(() => {
        /* No Google button without capabilities — the form still works. */
      });
    return () => {
      active = false;
    };
  }, []);

  const handleMagicLink = async (e: FormEvent) => {
    e.preventDefault();
    const targetEmail = email.trim();
    if (!targetEmail) return;

    setLoading(true);
    setError(null);
    try {
      const res = await authClient.signIn.magicLink({
        email: targetEmail,
        callbackURL: "/grid",
      });
      if (res?.error) {
        setError(res.error.message || "Failed to send magic link.");
      } else {
        setSent(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send magic link.");
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setGoogleLoading(true);
    setError(null);
    try {
      const res = await authClient.signIn.social({
        provider: "google",
        callbackURL: "/grid",
      });
      if (res?.error) {
        setError(res.error.message || "Failed to sign in with Google.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to sign in with Google.");
    } finally {
      setGoogleLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-6 shadow-xl">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-brand-primary text-sm font-bold text-brand-on-primary">
            CF
          </div>
          <h1 className="text-lg font-semibold text-text-primary">Sign in to Campaign Foundry</h1>
          <p className="mt-1 text-xs text-text-secondary">
            Deterministic creative generation and brand compliance
          </p>
        </div>

        {sent ? (
          <div className="space-y-4 text-center">
            <div className="rounded-lg bg-surface-2 p-4 text-sm text-text-primary">
              <p className="font-medium">Magic link sent!</p>
              <p className="mt-1 text-xs text-text-secondary">
                Check your email at <span className="font-mono text-text-primary">{email}</span> for
                your sign-in link.
              </p>
            </div>
            <Button
              variant="secondary"
              className="w-full text-xs"
              onClick={() => {
                setSent(false);
                setEmail("");
              }}
            >
              Use a different email
            </Button>
          </div>
        ) : (
          <form onSubmit={handleMagicLink} className="space-y-4">
            <div>
              <label
                htmlFor="email"
                className="mb-1.5 block text-xs font-medium text-text-secondary"
              >
                Email address
              </label>
              <Input
                id="email"
                type="email"
                name="email"
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                autoFocus
                disabled={loading}
              />
            </div>

            {error && (
              <p role="alert" className="text-xs text-error">
                {error}
              </p>
            )}

            <Button
              type="submit"
              variant="primary"
              className="w-full text-sm"
              disabled={loading || !email.trim()}
              isLoading={loading}
            >
              {loading ? "Sending magic link…" : "Continue with email"}
            </Button>
          </form>
        )}

        {capabilities?.auth?.google ? (
          <div className="mt-6 border-t border-border pt-4">
            <Button
              type="button"
              variant="secondary"
              className="w-full text-sm"
              onClick={handleGoogleSignIn}
              disabled={googleLoading}
              isLoading={googleLoading}
            >
              Continue with Google
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
