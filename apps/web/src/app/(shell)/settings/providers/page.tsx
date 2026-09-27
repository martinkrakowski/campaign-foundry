"use client";

import { useEffect, useState, type FormEvent } from "react";
import { getCapabilities, type HostCapabilities } from "@/lib/briefs-api";
import { authClient } from "@/lib/auth-client";
import {
  PROVIDERS,
  isProviderKeysApiError,
  listProviderKeys,
  revokeProviderKey,
  setProviderKey,
  type Provider,
  type ProviderKeySummary,
} from "@/lib/provider-keys-api";
import { Button, Card, CardContent, CardHeader, Input } from "@/components/ui";

const PROVIDER_LABELS: Record<Provider, string> = {
  gemini: "Gemini",
  openrouter: "OpenRouter",
  firefly: "Firefly",
};

/**
 * `owner`/`admin` manage keys; everyone else sees the list read-only
 * (`canManageProviderKeys` on the API, `provider-key.port.ts:78`). The role
 * comes back as a comma-joined string, same convention as
 * `membership.ts:33` — Better Auth's `get-active-member` route answers with
 * whatever is in the same `member.role` column.
 *
 * MUTATION ANCHOR (pt-7b3b-provider-keys-settings-ui): dropping this check
 * (returning `true` unconditionally) shows the write controls to every role —
 * caught by the member read-only test below.
 */
function canManageKeys(role: unknown): boolean {
  if (typeof role !== "string") return false;
  const roles = role.split(",").map((r) => r.trim());
  return roles.includes("owner") || roles.includes("admin");
}

type ListPhase = "loading" | "error" | "ok";

/**
 * Settings > provider keys (PT-7b3b). Under `AUTH_MODE=local` this asks the API
 * nothing at all — BYOK is org-scoped and local mode has no organisation — so the
 * capabilities probe is the only request until better-auth is confirmed.
 */
export default function ProviderKeysSettingsPage() {
  const [capabilities, setCapabilities] = useState<HostCapabilities | null>(null);

  useEffect(() => {
    let active = true;
    void getCapabilities()
      .then((caps) => {
        if (active) setCapabilities(caps);
      })
      .catch(() => {
        /* No settings without capabilities — the local-mode notice is the safe default. */
      });
    return () => {
      active = false;
    };
  }, []);

  // Nothing is known yet: render nothing rather than flash the local-mode notice for
  // a host that turns out to be better-auth once the boot probe resolves.
  if (capabilities === null) return null;

  if (capabilities.auth?.mode !== "better-auth") {
    return (
      <div className="mx-auto max-w-3xl p-4 sm:p-8">
        <h2 className="mb-1 text-lg font-semibold text-text-emphasis">Provider keys</h2>
        <p className="text-text-muted">
          Provider keys need an organisation account. Sign in with an organisation to manage them.
        </p>
      </div>
    );
  }

  return <BetterAuthProviderKeys />;
}

/**
 * The real page, mounted only under better-auth — so `useActiveMember` (a live
 * subscription) is never called under local mode, the same reason Header.tsx never
 * mounts `BetterAuthSection` there.
 */
function BetterAuthProviderKeys() {
  const activeMember = authClient.useActiveMember();
  const [phase, setPhase] = useState<ListPhase>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Separate from `phase`: the registered keys never need to be re-derived from a
  // union tag, so `onSaved`/`onRevoked` below update this directly with no branch
  // that asks "is the list even loaded" — by the time either fires, a `ProviderRow`
  // exists at all only because `phase === "ok"` already put it on screen.
  const [keys, setKeys] = useState<Partial<Record<Provider, ProviderKeySummary>>>({});

  useEffect(() => {
    let active = true;
    setPhase("loading");
    void listProviderKeys()
      .then((summaries) => {
        if (!active) return;
        const byProvider: Partial<Record<Provider, ProviderKeySummary>> = {};
        for (const summary of summaries) byProvider[summary.provider] = summary;
        setKeys(byProvider);
        setPhase("ok");
      })
      .catch((err: unknown) => {
        if (!active) return;
        setErrorMessage(
          isProviderKeysApiError(err) ? err.message : "Could not load provider keys.",
        );
        setPhase("error");
      });
    return () => {
      active = false;
    };
  }, []);

  const memberData = activeMember.data as { role?: unknown } | null | undefined;
  const canWrite = canManageKeys(memberData?.role);

  return (
    <div className="mx-auto max-w-3xl p-4 pb-12 sm:p-8">
      <h2 className="mb-1 text-lg font-semibold text-text-emphasis">Provider keys</h2>
      <p className="mb-6 text-[13px] text-text-muted">
        {canWrite
          ? "Register, replace or revoke your organisation's BYOK keys."
          : "Your organisation's registered provider keys."}
      </p>

      {phase === "loading" && <p className="text-text-muted">Loading…</p>}
      {phase === "error" && (
        <p role="alert" className="text-error">
          {errorMessage}
        </p>
      )}
      {phase === "ok" && (
        <div className="flex flex-col gap-4">
          {PROVIDERS.map((provider) => (
            <ProviderRow
              key={provider}
              provider={provider}
              summary={keys[provider]}
              canWrite={canWrite}
              onSaved={(summary) => {
                setKeys((prev) => ({ ...prev, [provider]: summary }));
              }}
              onRevoked={() => {
                setKeys((prev) => {
                  const next = { ...prev };
                  delete next[provider];
                  return next;
                });
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ProviderRow({
  provider,
  summary,
  canWrite,
  onSaved,
  onRevoked,
}: {
  readonly provider: Provider;
  readonly summary: ProviderKeySummary | undefined;
  readonly canWrite: boolean;
  readonly onSaved: (summary: ProviderKeySummary) => void;
  readonly onRevoked: () => void;
}) {
  const [key, setKey] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const label = PROVIDER_LABELS[provider];
  // `…abcd` — never the key itself (PT-7b3b item 2). The raw ISO date, not a
  // locale-formatted one: deterministic across every reader and every test.
  const state = summary ? `…${summary.last4} (${summary.createdAt.slice(0, 10)})` : "none";

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const payload = provider === "firefly" ? { clientId, clientSecret } : { key };
      const saved = await setProviderKey(provider, payload);
      onSaved(saved);
      // Clear on success — a write-only field never echoes what was typed, and never
      // leaves it sitting in the DOM after the save that consumed it.
      setKey("");
      setClientId("");
      setClientSecret("");
    } catch (err) {
      setError(isProviderKeysApiError(err) ? err.message : "Could not save the key.");
    } finally {
      setSaving(false);
    }
  };

  const handleRevoke = async () => {
    setRevoking(true);
    setError(null);
    try {
      await revokeProviderKey(provider);
      onRevoked();
    } catch (err) {
      setError(isProviderKeysApiError(err) ? err.message : "Could not revoke the key.");
    } finally {
      setRevoking(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <h3 className="text-sm font-medium text-text-emphasis">{label}</h3>
        <p className="text-[13px] text-text-muted">{state}</p>
      </CardHeader>
      {canWrite && (
        <CardContent>
          <form onSubmit={(e) => void handleSave(e)} className="flex flex-col gap-3">
            {provider === "firefly" ? (
              <>
                <div>
                  <label
                    htmlFor={`${provider}-client-id`}
                    className="mb-1 block text-xs font-medium text-text-secondary"
                  >
                    {label} client ID
                  </label>
                  <Input
                    id={`${provider}-client-id`}
                    type="password"
                    autoComplete="off"
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                  />
                </div>
                <div>
                  <label
                    htmlFor={`${provider}-client-secret`}
                    className="mb-1 block text-xs font-medium text-text-secondary"
                  >
                    {label} client secret
                  </label>
                  <Input
                    id={`${provider}-client-secret`}
                    type="password"
                    autoComplete="off"
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                  />
                </div>
              </>
            ) : (
              <div>
                <label
                  htmlFor={`${provider}-key`}
                  className="mb-1 block text-xs font-medium text-text-secondary"
                >
                  {label} key
                </label>
                <Input
                  id={`${provider}-key`}
                  type="password"
                  autoComplete="off"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                />
              </div>
            )}

            {error && (
              <p role="alert" className="text-xs text-error">
                {error}
              </p>
            )}

            <div className="flex gap-2">
              <Button type="submit" size="sm" isLoading={saving} disabled={saving || revoking}>
                {summary ? "Replace" : "Save"}
              </Button>
              {summary && (
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  isLoading={revoking}
                  disabled={saving || revoking}
                  onClick={() => void handleRevoke()}
                >
                  Revoke
                </Button>
              )}
            </div>
          </form>
        </CardContent>
      )}
    </Card>
  );
}
