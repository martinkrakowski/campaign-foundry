// Barrel for the domain-free UI kit. Hand-written (not hexagen-owned): the
// kit is a presentation package, not a hexagonal bounded context, and this
// surface is the public API consumers import. Do not add an @generated marker.
export { cn } from "./cn";
export { AxisCard, type AxisCardProps } from "./axis-card";
export { Button, type ButtonProps } from "./button";
export { Card, CardHeader, CardContent, type CardProps } from "./card";
export { CreativeGlyph, type CreativeGlyphProps, type LayoutOption, type ToneOption } from "./creative-glyph";
export { Input, type InputProps } from "./input";
export { RatioFrame, type RatioFrameProps, type RatioOption, type CanvasFrameProps } from "./ratio-frame";
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
export { ErrorPill } from "./error-pill";
export { OptionTile, type OptionTileProps } from "./option-tile";
export { SectionBlock, type SectionBlockProps } from "./section-block";
export { JumpStrip, type JumpStripItem, type JumpStripProps } from "./jump-strip";
export { GuardBar, type GuardBarAction, type GuardBarActionVariant, type GuardBarProps } from "./guard-bar";
// PreviewFrame is deliberately not exported: two different components share the name
// (this file and the editor's PreviewFrame) — a rename decision, not a reflex.
export { OverflowMenu, type OverflowMenuProps, type OverflowMenuItem } from "./overflow-menu";
export { MiniChip, type MiniChipProps, type MiniChipTone } from "./mini-chip";
export { EmptyNote, type EmptyNoteProps } from "./empty-note";
export { IconButton, type IconButtonProps } from "./icon-button";
export { Skeleton, type SkeletonProps } from "./skeleton";
export { Eyebrow, type EyebrowProps, type EyebrowTag } from "./eyebrow";
export { FieldLine, type FieldLineProps, type FieldLineTone } from "./field-line";
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
export { chaikin, polyPath, type Pt } from "./geo/chaikin";
export { pip } from "./geo/pip";
export {
  centroid,
  dotMatrix,
  GRATICULE_HORIZONTALS,
  GRATICULE_VERTICALS,
  MAP_HEIGHT,
  MAP_WIDTH,
  REGION_FOOTPRINTS,
  type Footprint,
  type MapDot,
} from "./geo/footprints";
export { WorldMap, type WorldMapProps } from "./world-map";
export { RegionChip, type RegionChipProps } from "./region-chip";
export { PosterFrame, frameSize, type PosterFrameProps, type PosterVariant } from "./poster-frame";
export { PreviewPanel, type PreviewPanelProps } from "./preview-panel";
export { PosterStack, type PosterStackProps } from "./poster-stack";
export { ScrubBar } from "./scrub-bar";
export { LAYERS, times, PREVIEW_BOX, fractionOfBox, canvasSpecOf, frameBox, type BoxFraction } from "./preview-layers";
