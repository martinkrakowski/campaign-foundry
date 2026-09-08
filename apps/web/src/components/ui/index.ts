// Barrel for the base UI kit. The domain-free files live in @campaignfoundry/ui;
// this barrel re-exports that package so existing `@/components/ui` call sites
// keep compiling. The four files that import the campaign feature stay here.
export * from "@campaignfoundry/ui";
export { ConfirmDialog, type ConfirmDialogProps } from "./confirm-dialog";
export { SegBar, type SegBarProps, type SegBarSegment } from "./seg-bar";
export { ThemeToggle } from "./theme-toggle";
// SectionOutline is deliberately not exported: it imports campaign/sections,
// campaign/editor-state, campaign/validate and campaign/messages, so barrelling it
// would pull four campaign modules into every consumer of this barrel (D87).
// PreviewFrame is deliberately not exported: two different components share the name
// (ui/PreviewFrame.tsx and campaign/PreviewFrame.tsx) — a rename decision, not a reflex.
