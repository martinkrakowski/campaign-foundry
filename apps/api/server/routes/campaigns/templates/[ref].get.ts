import { errorMessage } from "@campaignfoundry/shared";
import { getTemplateStore } from "../../../lib/ports/index.js";

import { LOCAL_TENANT } from "../../../lib/tenant.js";
/**
 * A version segment must be the canonical spelling of a positive integer: no
 * sign, no fraction, no leading `+`, and — because `Number("007")` and
 * `Number("7")` are the same value but the caller did not pin the same
 * string — no leading zeros either. `007` is rejected rather than silently
 * read as `7`.
 */
const VERSION_PATTERN = /^[1-9][0-9]*$/;

/**
 * GET /campaigns/templates/:ref — one template pinned by reference (D123, L7).
 *
 * `:ref` is `id` or `id@version`. L7's own wording is `GET /templates/:id@:version`;
 * an `@` inside a single path segment is legal and the router (and any HTTP
 * client) is free to percent-encode it, so a literal `@` in the URL, one path
 * segment, and no query string is the most direct rendering of that shape —
 * closer than a second `:version` segment or a `?version=` query, either of
 * which would work but drift from the wording the plan already commits to.
 *
 * The split is on the *last* `@`, not the first: `CreativeTemplate.id` is an
 * unconstrained string (nothing validates it as a slug), so an id containing
 * `@` is representable, and `"a@b@3"` must resolve to id `"a@b"`, version 3,
 * not id `"a"`, version `"b@3"`. This does not fully solve id/version
 * ambiguity: an id containing `@` with **no** version pinned (`"a@b"` alone)
 * still splits into id `"a"`, version `"b"`, and 400s if `"b"` is not a
 * canonical positive integer — there is no way to tell "no version" from "a
 * version-shaped suffix" without a validated id shape, which is outside this
 * lane (the port and `CreativeTemplate.id` are not ours to change here).
 *
 * No version → the highest version present (the port's own default). An
 * exact version the store does not have is a 404 — never a different version
 * of the same id, because serving one would silently break D123's
 * immutability promise on the wire; the port already refuses that fallback,
 * this route must not reintroduce it. A version that does not parse as a
 * canonical positive integer, or that is too large to represent exactly as a
 * `number` (`Number("9007199254740993") === 9007199254740992` — silent
 * precision loss would serve a different version than the one pinned, the
 * same promise broken a different way), is a 400 naming the field, not a 404
 * and not a silent "latest".
 */
export default defineEventHandler(async (event) => {
  const ref = String(getRouterParam(event, "ref"));
  const at = ref.lastIndexOf("@");
  const id = at === -1 ? ref : ref.slice(0, at);
  const versionRaw = at === -1 ? undefined : ref.slice(at + 1);

  let version: number | undefined;
  if (versionRaw !== undefined) {
    if (!VERSION_PATTERN.test(versionRaw)) {
      setResponseStatus(event, 400);
      return {
        error: `Invalid "version": "${versionRaw}" must be a positive integer with no leading zeros.`,
      };
    }
    if (BigInt(versionRaw) > BigInt(Number.MAX_SAFE_INTEGER)) {
      setResponseStatus(event, 400);
      return {
        error: `Invalid "version": "${versionRaw}" exceeds the largest exactly representable version (${Number.MAX_SAFE_INTEGER}).`,
      };
    }
    version = Number(versionRaw);
  }

  let template;
  try {
    template = await getTemplateStore(LOCAL_TENANT).findTemplate(id, version);
  } catch (error) {
    console.warn(`[templates] could not read template: ${errorMessage(error)}`);
    setResponseStatus(event, 500);
    return { error: `Could not read template: ${errorMessage(error)}` };
  }

  if (!template) {
    setResponseStatus(event, 404);
    return { error: `Template not found: "${ref}"` };
  }
  return { template };
});
