import { BriefEditor } from "@/components/campaign/BriefEditor";

/**
 * D37: a brief's identity lives in the URL. This route *is* which brief is open — a
 * reload or a shared link lands on exactly this brief, and the editor loads it from
 * here. The id travels to the editor unvalidated: rejecting a malformed one with
 * `SAFE_ID_PATTERN` is the editor's answer (the M3 empty state), which keeps the one
 * id rule in one place.
 */
export default async function BriefIdPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <BriefEditor briefId={id} />;
}
