// Barrel for the base UI kit. Import from this directory (e.g.
// "@/components/ui") rather than the individual files so the public surface
// stays stable as components grow.
export { AxisCard, type AxisCardProps } from "./axis-card";
export { Button, type ButtonProps } from "./button";
export { Card, CardHeader, CardContent, type CardProps } from "./card";
export { CreativeGlyph, type CreativeGlyphProps, type LayoutOption, type ToneOption } from "./creative-glyph";
export { Input, type InputProps } from "./input";
export { RatioFrame, type RatioFrameProps, type RatioOption } from "./ratio-frame";
export { Slider, type SliderProps } from "./slider";
export { Stepper, type StepperProps } from "./stepper";
export { Disclosure } from "./disclosure";
export { PreviewCard, type PreviewCardProps } from "./preview-card";
export { SwatchChip, hueShiftHex, type SwatchChipProps } from "./swatch-chip";
export { SwitchRow, type SwitchRowProps } from "./switch-row";
export { ChipGroup, type ChipGroupProps } from "./chip-group";
export { SwatchPicker, SWATCH_PALETTE, type SwatchPickerProps } from "./swatch-picker";
export { PlatformCard, type PlatformCardProps } from "./platform-card";
export {
  DurationStrip,
  slideToFree,
  secondsAtClientX,
  keyToTarget,
  type DurationStripProps,
} from "./duration-strip";
export { ConfirmDialog, type ConfirmDialogProps } from "./confirm-dialog";
export { OverflowMenu, type OverflowMenuProps, type OverflowMenuItem } from "./overflow-menu";
export { MiniChip, type MiniChipProps, type MiniChipTone } from "./mini-chip";
export { EmptyNote, type EmptyNoteProps } from "./empty-note";
export { IconButton, type IconButtonProps } from "./icon-button";
export { Skeleton, type SkeletonProps } from "./skeleton";
export { Eyebrow, type EyebrowProps, type EyebrowTag } from "./eyebrow";
export { FieldLine, type FieldLineProps, type FieldLineTone } from "./field-line";
export { SegBar, type SegBarProps, type SegBarSegment } from "./seg-bar";
export { ThemeToggle } from "./theme-toggle";
export {
  DialogHead,
  DialogBody,
  DialogFoot,
  DialogShell,
  DrawerShell,
  useDialogFocusTrap,
  getFocusableDialogElements,
  dialogHoldsFocus,
  type DialogHeadProps,
  type DialogBodyProps,
  type DialogFootProps,
  type DialogShellProps,
  type DrawerShellProps,
  type UseDialogFocusTrapOptions,
} from "./dialog-shell";

