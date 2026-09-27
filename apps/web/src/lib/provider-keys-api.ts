import { handleAuthError } from "./auth-errors";

/**
 * Org BYOK provider keys (PT-7b2 #604, PT-7b3a #607) — settings-page client
 * (PT-7b3b). Mirrors `briefs-api.ts`'s `requestJson`/`errorFrom` shape: same
 * base path, same `{ error }` body convention, same 401/403 handling through
 * `handleAuthError`. A key's plaintext is never sent to this module except as
 * the body of a `PUT` the caller just typed — this file never logs, stores or
 * echoes it.
 */

/** Same three providers the API's `ProviderKeyPort` knows (`provider-key.port.ts`). */
export const PROVIDERS = ["gemini", "openrouter", "firefly"] as const;

export type Provider = (typeof PROVIDERS)[number];

export function isProvider(value: unknown): value is Provider {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

/** What `GET /campaigns/provider-keys` answers per provider — never the key. */
export interface ProviderKeySummary {
  readonly provider: Provider;
  readonly last4: string;
  readonly createdAt: string;
}

/** Same path as run-context `API` (see `briefs-api.ts`). */
const API = "/api/pipeline";

/** HTTP error whose message is the API's `{ error }` string when present. */
export class ProviderKeysApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ProviderKeysApiError";
    this.status = status;
  }
}

export function isProviderKeysApiError(error: unknown): error is ProviderKeysApiError {
  return error instanceof ProviderKeysApiError;
}

async function parseJsonBody(res: Response): Promise<unknown> {
  const raw = await res.text();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function errorFrom(data: unknown, fallback: string): string {
  if (typeof data === "object" && data !== null) {
    const message = (data as { error?: unknown }).error;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return fallback;
}

/** `list`'s fallback when a non-503 error carries no `{ error }` message. */
function listFallback(status: number): string {
  return status === 503
    ? "Provider keys are currently unavailable."
    : `Request failed (HTTP ${status})`;
}

/**
 * `set`'s fallback per status the PUT route can answer (`[provider].put.ts`).
 * Every branch below is reachable from a real 400/403/409 response that
 * omits `{ error }` — the route itself always sends one, so this only fires
 * for a malformed or truncated body, but the shape is still validated.
 */
function setFallback(status: number): string {
  if (status === 400) return "Invalid provider key payload.";
  if (status === 403) return "Only an owner or admin may manage provider keys.";
  if (status === 409) return "Provider key was replaced concurrently; retry.";
  return `Request failed (HTTP ${status})`;
}

async function requestJson(
  url: string,
  fallbackFor: (status: number) => string,
  init?: RequestInit,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ProviderKeysApiError("Network error", 0);
  }
  let data: unknown;
  try {
    data = await parseJsonBody(res);
  } catch {
    // The body is a stream: it can still fail after fetch resolved (briefs-api.ts's
    // capabilities probe hits the same failure mode) — `res.status` is still the
    // real HTTP status, but nothing usable came back as a message.
    throw new ProviderKeysApiError("Network error", res.status);
  }
  if (!res.ok) {
    handleAuthError(res.status, data);
    throw new ProviderKeysApiError(errorFrom(data, fallbackFor(res.status)), res.status);
  }
  return data;
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

/** `GET /campaigns/provider-keys` — the org's registered keys, never the key itself. */
export async function listProviderKeys(): Promise<ProviderKeySummary[]> {
  const data = await requestJson(`${API}/campaigns/provider-keys`, listFallback);
  if (!Array.isArray(data)) {
    throw new ProviderKeysApiError("Invalid provider keys response", 500);
  }
  return data as ProviderKeySummary[];
}

/**
 * `PUT /campaigns/provider-keys/:provider` — register or replace a key.
 * Gemini and OpenRouter take `{ key }`; Firefly takes `{ clientId, clientSecret }`
 * (the route's own split, `plaintextFromBody` in `[provider].put.ts`). Only
 * `owner`/`admin` may call this — a 403 is the API's own answer, not a
 * client-side guess.
 */
export async function setProviderKey(
  provider: Provider,
  payload: { key: string } | { clientId: string; clientSecret: string },
): Promise<ProviderKeySummary> {
  const data = await requestJson(
    `${API}/campaigns/provider-keys/${provider}`,
    setFallback,
    jsonInit("PUT", payload),
  );
  return data as ProviderKeySummary;
}

/**
 * `DELETE /campaigns/provider-keys/:provider` — revoke the org's active key.
 * A no-op on the server when none is active, so this never distinguishes
 * "revoked" from "already gone".
 */
export async function revokeProviderKey(provider: Provider): Promise<void> {
  await requestJson(
    `${API}/campaigns/provider-keys/${provider}`,
    (status) => `Request failed (HTTP ${status})`,
    {
      method: "DELETE",
    },
  );
}
