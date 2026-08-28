import { redirect } from "next/navigation";

/**
 * The step wizard that used to live here is gone: `/brief` is the one campaign editor
 * (D1 of the unified-editor plan), and `/brief/new` is its blank start. Kept as a
 * redirect so a bookmark from the wizard's lifetime still lands somewhere useful.
 */
export default function NewCampaignPage() {
  redirect("/brief/new");
}
