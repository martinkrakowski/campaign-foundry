import { FileSystemInputAssets } from "../FileSystemInputAssets.js";

/**
 * The confined reader every test in this folder builds its adapters around.
 *
 * Since PT-4c the five consumers take an `InputAssetPort` rather than an asset
 * root, so a suite that wants a real filesystem read — a real logo, a real scene,
 * a real music bed — builds the adapter the composition root builds:
 * `FileSystemInputAssets` over the root it already had. One helper, 29 files, and
 * a suite's own root still comes from `projectRoot()` (or its own fixture root),
 * exactly as before; what changed is only what wraps it.
 */
export const fsInputs = (root: string): FileSystemInputAssets => new FileSystemInputAssets(root);
