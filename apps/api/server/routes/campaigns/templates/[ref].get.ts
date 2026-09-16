import { errorMessage } from "@campaignfoundry/shared";
import { getTemplateStore } from "../../../lib/ports/index.js";

/** A version segment must be a positive integer — no sign, no fraction, no leading `+`. */
const VERSION_PATTERN = /^[0-9]+$/;

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
 * No version → the highest version present (the port's own default). An
 * exact version the store does not have is a 404 — never a different version
 * of the same id, because serving one would silently break D123's
 * immutability promise on the wire; the port already refuses that fallback,
 * this route must not reintroduce it. A version that does not parse as a
 * positive integer is a 400 naming the field, not a 404 and not a silent
 * "latest".
 */
export default defineEventHandler(async (event) => {
  const ref = String(getRouterParam(event, "ref"));
  const at = ref.indexOf("@");
  const id = at === -1 ? ref : ref.slice(0, at);
  const versionRaw = at === -1 ? undefined : ref.slice(at + 1);

  let version: number | undefined;
  if (versionRaw !== undefined) {
    if (!VERSION_PATTERN.test(versionRaw) || Number(versionRaw) === 0) {
      setResponseStatus(event, 400);
      return {
        error: `Invalid "version": "${versionRaw}" must be a positive integer.`,
      };
    }
    version = Number(versionRaw);
  }

  let template;
  try {
    template = await getTemplateStore().findTemplate(id, version);
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
