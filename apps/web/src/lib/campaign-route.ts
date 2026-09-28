/**
 * PT-5c1 (D178) — the one place `/brief/<id>` is spelled. `id` is a campaign
 * uuid or its slug (the route resolves either, #613); the picker, the
 * sidebar, the create flow and the editor's own navigation all route through
 * this helper rather than hand-building the path, so a future change to the
 * route shape (or to how an id is encoded into it) has one call site to fix
 * instead of nine hand-built strings drifting apart.
 */
export function campaignRoute(id: string): string {
  return `/brief/${encodeURIComponent(id)}`;
}
