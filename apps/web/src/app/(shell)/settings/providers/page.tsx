"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { getCapabilities, type HostCapabilities } from "@/lib/briefs-api";
import { authClient } from "@/lib/auth-client";
import { useEditorDirty } from "@/lib/editor-dirty-context";
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

/**
 * Plain messages by HTTP status only — fix round PRRT_kwDOSzP1zc6mXO6b. The
 * API's own `{ error }` text is written for an operator debugging a
 * misconfigured host ("KEY_ENCRYPTION_KEYS is not set…",
 * "STORE_BACKEND=postgres…") and must never reach an owner clicking Save, so
 * nothing in this file reads `err.message` for display — every error, from
 * every route this page calls, resolves through this one map.
 */
function messageForError(err: unknown): string {
  const status = isProviderKeysApiError(err) ? err.status : undefined;
  switch (status) {
    case 400:
      return "That key doesn't look right. Check it and try again.";
    case 403:
      return "Only owners and admins can manage provider keys.";
    case 409:
      return "That key was just updated somewhere else. Try again.";
    case 503:
      return "Provider keys aren't available on this host right now. Try again shortly.";
    default:
      return "Something went wrong. Try again.";
  }
}

type ProbeState =
  | { status: "probing" }
  | { status: "failed" }
  | { status: "ok"; capabilities: HostCapabilities };

/**
 * Settings > provider keys (PT-7b3b). Under `AUTH_MODE=local` this asks the API
 * nothing at all — provider keys are org-scoped and local mode has no
 * organisation — so the capabilities probe is the only request until
 * better-auth is confirmed. A probe that fails outright (rather than resolving
 * with a definite mode) gets its own state with a Retry, rather than leaving
 * the route blank (fix round PRRT_kwDOSzP1zc6mXMC3 / PRRT_kwDOSzP1zc6mXO6f).
 */
export default function ProviderKeysSettingsPage() {
  const [probe, setProbe] = useState<ProbeState>({ status: "probing" });
  // Bumped by Retry — an effect dependency, not a call inside the click handler,
  // so the same `active`-flag cleanup this effect always had still applies to a
  // retry's own in-flight request.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setProbe({ status: "probing" });
    void getCapabilities()
      .then((caps) => {
        if (!active) return;
        // `briefs-api.ts`'s `getCapabilities` resolves `null` for every failure it
        // sees itself (network error, non-2xx, malformed body) — it does not throw.
        // A `null` answer and a rejected promise are therefore the same fact here:
        // the probe did not get a real answer, and this page has no organisation
        // to trust with a request until one comes back positive.
        setProbe(caps === null ? { status: "failed" } : { status: "ok", capabilities: caps });
      })
      .catch(() => {
        if (!active) return;
        setProbe({ status: "failed" });
      });
    return () => {
      active = false;
    };
  }, [attempt]);

  // Nothing is known yet: render nothing rather than flash a wrong state for a
  // host whose real answer hasn't landed.
  if (probe.status === "probing") return null;

  if (probe.status === "failed") {
    return (
      <div className="mx-auto max-w-3xl p-4 sm:p-8">
        <h2 className="mb-1 text-lg font-semibold text-text-emphasis">Provider keys</h2>
        <p role="alert" className="mb-4 text-error">
          Could not check this host's settings.
        </p>
        <Button size="sm" onClick={() => setAttempt((a) => a + 1)}>
          Retry
        </Button>
      </div>
    );
  }

  if (probe.capabilities.auth?.mode !== "better-auth") {
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

type ListPhase = "loading" | "error" | "ok";

/**
 * The real page, mounted only under better-auth — so `useActiveMember` (a live
 * subscription) is never called under local mode, the same reason Header.tsx never
 * mounts `BetterAuthSection` there.
 */
function BetterAuthProviderKeys() {
  const activeMember = authClient.useActiveMember();
  const { setDirty } = useEditorDirty();
  const [phase, setPhase] = useState<ListPhase>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Separate from `phase`: the registered keys never need to be re-derived from a
  // union tag, so `onSaved`/`onRevoked` below update this directly with no branch
  // that asks "is the list even loaded" — by the time either fires, a `ProviderRow`
  // exists at all only because `phase === "ok"` already put it on screen.
  const [keys, setKeys] = useState<Partial<Record<Provider, ProviderKeySummary>>>({});
  // Whether each row currently has a non-empty, unsaved field (PRRT_kwDOSzP1zc6mXO6d).
  const [dirtyRows, setDirtyRows] = useState<Partial<Record<Provider, boolean>>>({});

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
        setErrorMessage(messageForError(err));
        setPhase("error");
      });
    return () => {
      active = false;
    };
  }, []);

  // One row's typed-but-unsaved input must not read as "the page is dirty" for
  // every other row too, and a pristine row reporting in must not clear a dirty
  // sibling's flag — an aggregate over every row's own boolean, published as one
  // flag rather than each row racing to call `setDirty` with its own view of the
  // whole page.
  const anyDirty = Object.values(dirtyRows).some(Boolean);
  const lastPublishedDirtyRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (lastPublishedDirtyRef.current !== anyDirty) {
      lastPublishedDirtyRef.current = anyDirty;
      setDirty(anyDirty);
    }
  }, [anyDirty, setDirty]);

  // The provider outlives this route (same reason BriefEditor.tsx splits this from
  // the effect above): clear on unmount only, so leaving this page — with or
  // without saving — never leaves a later page prompting about a route that is
  // long gone.
  useEffect(() => () => setDirty(false), [setDirty]);

  const memberData = activeMember.data as { role?: unknown } | null | undefined;
  const canWrite = canManageKeys(memberData?.role);

  return (
    <div className="mx-auto max-w-3xl p-4 pb-12 sm:p-8">
      <h2 className="mb-1 text-lg font-semibold text-text-emphasis">Provider keys</h2>
      <p className="mb-6 text-[13px] text-text-muted">
        {canWrite
          ? "Register, replace or revoke your organisation's provider keys."
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
              onDirtyChange={(dirty) => {
                setDirtyRows((prev) =>
                  prev[provider] === dirty ? prev : { ...prev, [provider]: dirty },
                );
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
  onDirtyChange,
}: {
  readonly provider: Provider;
  readonly summary: ProviderKeySummary | undefined;
  readonly canWrite: boolean;
  readonly onSaved: (summary: ProviderKeySummary) => void;
  readonly onRevoked: () => void;
  readonly onDirtyChange: (dirty: boolean) => void;
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

  // Only a boolean crosses into the shared dirty context — never the typed value
  // itself (PRRT_kwDOSzP1zc6mXO6d: "never put the typed value into that context").
  //
  // No ref-guard here: `onDirtyChange` is a fresh closure every time the parent
  // re-renders (it is defined inline in its `.map()`), so this effect re-runs on
  // every parent render regardless of whether `hasInput` actually changed for
  // THIS row — deduping that down to real transitions only would just move the
  // guard from where the state of record lives (the parent's `dirtyRows`,
  // `prev[provider] === dirty` below) to a second copy of the same check up
  // here. The parent's own check is what makes a same-value call a no-op —
  // `setDirtyRows` there returns `prev` unchanged, and React bails out of
  // re-rendering on that referential equality — so this effect can call
  // `onDirtyChange` unconditionally and the redundant round trip it causes on
  // every re-render (including this row's own mount, and every sibling row's
  // mount) settles in one extra pass, not a loop.
  // Losing write access (the active membership changed to a read-only role)
  // hides the form, so drop whatever was typed into it: the key leaves memory,
  // and the page stops reporting an unsaved key nobody can see or save.
  useEffect(() => {
    if (!canWrite) {
      setKey("");
      setClientId("");
      setClientSecret("");
    }
  }, [canWrite]);

  const hasInput = provider === "firefly" ? clientId !== "" || clientSecret !== "" : key !== "";
  useEffect(() => {
    onDirtyChange(hasInput);
  }, [hasInput, onDirtyChange]);

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const payload = provider === "firefly" ? { clientId, clientSecret } : { key };
      const saved = await setProviderKey(provider, payload);
      onSaved(saved);
      // Clear on success — a write-only field never echoes what was typed, and never
      // leaves it sitting in the DOM after the save that consumed it. This also
      // clears the row's own dirty flag, through the effect above.
      setKey("");
      setClientId("");
      setClientSecret("");
    } catch (err) {
      setError(messageForError(err));
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
      setError(messageForError(err));
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
