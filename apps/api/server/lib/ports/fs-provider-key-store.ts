import {
  ProviderKeyUnavailableError,
  type Provider,
  type ProviderKeyPort,
  type ProviderKeySummary,
} from "./provider-key.port.js";

const MESSAGE =
  "Org provider keys need STORE_BACKEND=postgres: BYOK is Postgres-only, as Better Auth already is.";

/**
 * BYOK is Postgres-only (D175; plan §4.4, PT-7b2): the fs backend has no
 * table to hold a sealed key. Every method answers the same 503-shaped
 * error naming what's missing, rather than silently pretending the local
 * operator has no keys or, worse, storing one unsealed on disk.
 */
export class FsProviderKeyStore implements ProviderKeyPort {
  async put(_provider: Provider, _plaintext: string, _actor: string): Promise<ProviderKeySummary> {
    throw new ProviderKeyUnavailableError(MESSAGE);
  }

  async list(): Promise<ProviderKeySummary[]> {
    throw new ProviderKeyUnavailableError(MESSAGE);
  }

  async revoke(_provider: Provider): Promise<void> {
    throw new ProviderKeyUnavailableError(MESSAGE);
  }

  async open(_provider: Provider): Promise<string | undefined> {
    throw new ProviderKeyUnavailableError(MESSAGE);
  }
}
