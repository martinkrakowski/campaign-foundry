import { redirect } from "next/navigation";

/** The app opens on the review grid. */
export default function IndexPage() {
  redirect("/grid");
}
