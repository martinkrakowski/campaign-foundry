"use client";

import { useState } from "react";
import type { Dispatch } from "react";
import { Button, Eyebrow, Input, SwatchPicker } from "@/components/ui";
import * as messages from "@/components/campaign/messages";
import type { EditorState, EditorAction } from "@/components/campaign/editor-state";
import type { FieldErrors } from "@/components/campaign/validate";
import { SectionShell, Field } from "./IdentitySection";
import { LogoField } from "@/components/campaign/LogoField";
import { uploadAsset, isBriefsApiError, unknownErrorMessage } from "@/lib/briefs-api";
import type { AssetEntry } from "@/lib/briefs-api";
import { assetRefFor, describeAssetRef, isAssetId } from "@/lib/asset-refs";
import { assetFileName, fileToBase64 } from "@/components/campaign/editor-state";

/**
 * The ref to store when the upload answered 409 — the asset is already there, so
 * the brief should point at the existing one rather than at the rejected name.
 *
 * The listing the editor has ALREADY loaded is the only place that ref can be read
 * from: the 409 carries no body, and an entry under the object backend is named by
 * its id. So the entry is looked up by name in what is in memory and `assetRefFor`
 * decides the ref shape, exactly as it does for a pick.
 *
 * **It asks for nothing.** A 409 arrives from a POST the host already refused, and
 * reaching for the listing over the network to answer it would be a request the
 * filesystem backend never made before this lane — on fs there is no id to find, so
 * the answer is today's path either way. Every way this can fail to find the entry
 * — never fetched, the asset is not in it, the entry has no id — answers today's
 * path string, which is the ref the server accepts on either backend.
 *
 * Synchronous, and that is the point: with nothing to await there is no dispatch
 * after an async boundary, so no "is this section still mounted" question and no
 * `AbortSignal` that nothing would read.
 */
function refForExistingAsset(
  briefId: string,
  name: string,
  listing: readonly AssetEntry[] | undefined,
): string {
  const entry = listing?.find((candidate) => candidate.name === name);
  return entry === undefined ? `assets/inputs/${briefId}/${name}` : assetRefFor(entry, briefId);
}

function ProductRow({
  product,
  index,
  dispatch,
  uploadingKeys,
  onLogoFile,
  onChooseFromBin,
  errors,
  assets,
  assetsRefetching,
}: {
  product: EditorState["products"][number];
  index: number;
  dispatch: Dispatch<EditorAction>;
  uploadingKeys: ReadonlySet<number>;
  onLogoFile: (key: number, productId: string, file: File) => Promise<void> | void;
  onChooseFromBin: (key: number) => void;
  errors: FieldErrors;
  /**
   * The campaign's asset listing, or `undefined` while it has not been fetched.
   * Consulted only for an id ref: a path ref already carries its own name, so it
   * resolves with nothing and `undefined` is never even read.
   */
  assets?: readonly AssetEntry[];
  /**
   * Whether a listing request is in flight right now (see `describeAssetRef`). An id
   * the landed listing does not hold reads "Loading asset…" until the fetch settles,
   * rather than flashing a name-less tile for a round trip.
   */
  assetsRefetching?: boolean;
}) {
  const [editingId, setEditingId] = useState(false);
  const hasIdError = Boolean(errors[`product-${index}-id`]);
  const showIdInput = editingId || product.idTouched || hasIdError;
  // An id ref (D203) has to be turned back into a name through the listing, or the
  // tile renders a uuid. A path ref resolves with its own basename and takes none of
  // the three resolved props, so a filesystem-shaped brief renders byte for byte as
  // it always has.
  const logo = isAssetId(product.logoPath)
    ? describeAssetRef(product.logoPath, assets, assetsRefetching)
    : undefined;

  return (
    <div className="space-y-4 rounded-lg border border-border bg-surface p-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field
          fieldKey={`product-${index}-name`}
          label={messages.productNameLabel}
          error={errors[`product-${index}-name`]}
        >
          <Input
            value={product.name}
            placeholder={messages.productNamePlaceholder}
            onChange={(e) =>
              dispatch({ type: "setProduct", key: product.key, patch: { name: e.target.value } })
            }
            invalid={Boolean(errors[`product-${index}-name`])}
          />
        </Field>
        <Field
          fieldKey={`product-${index}-id`}
          label={messages.productIdLabel}
          error={errors[`product-${index}-id`]}
          as={showIdInput ? "label" : "div"}
        >
          {(control) =>
            showIdInput ? (
              <Input
                {...control}
                value={product.id}
                placeholder={messages.productIdPlaceholder}
                onChange={(e) =>
                  dispatch({ type: "setProduct", key: product.key, patch: { id: e.target.value } })
                }
                invalid={hasIdError}
                autoFocus={editingId}
              />
            ) : (
              <div className="flex h-10 items-center justify-between rounded-md border border-border bg-surface-2 px-3">
                <span className="font-mono text-[12px] text-text-primary truncate">
                  {product.id || messages.productIdReadout}
                </span>
                <button
                  type="button"
                  onClick={() => setEditingId(true)}
                  className="font-mono text-[11px] text-text-muted hover:text-text-emphasis transition-colors"
                  aria-label={messages.productIdEditAria}
                >
                  {messages.productIdEdit}
                </button>
                <input
                  {...control}
                  type="text"
                  aria-label={messages.productIdLabel}
                  className="sr-only"
                  value={product.id}
                  onChange={(e) =>
                    dispatch({
                      type: "setProduct",
                      key: product.key,
                      patch: { id: e.target.value },
                    })
                  }
                  tabIndex={-1}
                />
              </div>
            )
          }
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field
          fieldKey={`product-${index}-color`}
          label={messages.productColorLabel}
          error={errors[`product-${index}-color`]}
          as="div"
        >
          <SwatchPicker
            label={messages.productColorLabel}
            value={product.primaryColor}
            onChange={(hex) =>
              dispatch({ type: "setProduct", key: product.key, patch: { primaryColor: hex } })
            }
            invalid={Boolean(errors[`product-${index}-color`])}
          />
        </Field>
        <Field
          fieldKey={`product-${index}-logo`}
          label={messages.productLogoLabel}
          error={errors[`product-${index}-logo`]}
          as="div"
        >
          <LogoField
            value={product.logoPath}
            productColor={product.primaryColor}
            displayName={logo?.label}
            thumbnailUrl={logo?.thumbnailUrl}
            fileSize={logo?.size}
            onChange={(path) =>
              dispatch({ type: "setProduct", key: product.key, patch: { logoPath: path } })
            }
            onUploadFile={(file) => onLogoFile(product.key, product.id, file)}
            onChooseFromBin={() => onChooseFromBin(product.key)}
            uploading={uploadingKeys.has(product.key)}
            invalid={Boolean(errors[`product-${index}-logo`])}
          />
        </Field>
      </div>

      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          type="button"
          onClick={() => dispatch({ type: "removeProduct", key: product.key })}
        >
          {messages.productRemove}
        </Button>
      </div>
    </div>
  );
}

export function ProductsSection({
  state,
  dispatch,
  errors,
  onChooseFromBin,
  assets,
  assetsRefetching,
}: {
  state: EditorState;
  dispatch: Dispatch<EditorAction>;
  errors: FieldErrors;
  /**
   * M7 — the Asset Bin drawer is not rendered here. The original culprit was the
   * guided step card's permanent transform (the walk's animation), which made it
   * the CONTAINING BLOCK for `fixed` descendants, so a drawer mounted inside it
   * was trapped in the card instead of covering the viewport. The card is gone
   * (SG1) but the rule is not: any ancestor that acquires a transform would do
   * the same. The drawer lives at `BriefEditor`'s root (the same hoist
   * `HeadlinePoolDrawer` has), so this section publishes only the request — the
   * product key whose logo the bin would fill.
   */
  onChooseFromBin: (key: number) => void;
  /**
   * The campaign's asset listing (D203), published by `BriefEditor` and read only
   * where a product's logo is an id ref. Absent means "not fetched", which the
   * field says out loud rather than rendering a uuid.
   */
  assets?: readonly AssetEntry[];
  /** Whether a listing request is in flight right now — see `ProductRow`. */
  assetsRefetching?: boolean;
}) {
  const [uploadError, setUploadError] = useState<string | undefined>();
  const [uploadingKeys, setUploadingKeys] = useState<ReadonlySet<number>>(new Set());

  const onLogoFile = async (key: number, productId: string, file: File) => {
    setUploadError(undefined);
    setUploadingKeys((prev) => new Set(prev).add(key));
    const name = assetFileName(file.name, productId);
    try {
      const contentBase64 = await fileToBase64(file);
      // `id ?? path`, not `path`: under the object backend the upload answers with
      // the asset row's uuid and that is the ref the server's own resolver reads
      // back. Under fs no answer carries an id, so this is the same path string as
      // before — without a backend probe, and without one request more than fs.
      const { path, id } = await uploadAsset({
        briefId: state.briefId,
        name,
        contentBase64,
      });
      dispatch({ type: "setProduct", key, patch: { logoPath: id ?? path } });
    } catch (error) {
      if (isBriefsApiError(error) && error.status === 409) {
        // 409 means the asset already exists, so the POST never ran and there is no
        // response body to read an id from — the listing the editor already holds is
        // where it is. No request: a 409 is not a reason to go and ask again.
        dispatch({
          type: "setProduct",
          key,
          patch: { logoPath: refForExistingAsset(state.briefId, name, assets) },
        });
      } else {
        setUploadError(unknownErrorMessage(error, messages.productUploadErrorFallback));
      }
    } finally {
      setUploadingKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  return (
    <SectionShell
      id="products"
      title="3 · Products"
      errorCount={Object.keys(errors).filter((k) => k.startsWith("product")).length}
    >
      {errors.products ? <p className="text-[13px] text-error">{errors.products}</p> : null}
      {uploadError ? <p className="text-[13px] text-error">{uploadError}</p> : null}
      <div className="flex items-center justify-between">
        <Eyebrow as="h3">{messages.productsHeading(state.products.length)}</Eyebrow>
        <Button
          variant="secondary"
          size="sm"
          type="button"
          onClick={() => dispatch({ type: "addProduct" })}
        >
          {messages.addProduct}
        </Button>
      </div>
      {state.products.map((product, index) => (
        <ProductRow
          key={product.key}
          product={product}
          index={index}
          dispatch={dispatch}
          uploadingKeys={uploadingKeys}
          onLogoFile={onLogoFile}
          onChooseFromBin={() => onChooseFromBin(product.key)}
          errors={errors}
          assets={assets}
          assetsRefetching={assetsRefetching}
        />
      ))}
    </SectionShell>
  );
}
