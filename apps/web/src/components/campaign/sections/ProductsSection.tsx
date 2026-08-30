"use client";

import { useState } from "react";
import type { Dispatch } from "react";
import { Button, Input, SwatchPicker } from "@/components/ui";
import * as messages from "@/components/campaign/messages";
import type { EditorState, EditorAction } from "@/components/campaign/editor-state";
import type { FieldErrors } from "@/components/campaign/validate";
import { SectionShell, Field } from "./IdentitySection";
import { LogoField } from "@/components/campaign/LogoField";
import { AssetPickerDrawer } from "@/components/campaign/AssetPickerDrawer";
import { uploadAsset, isBriefsApiError, unknownErrorMessage } from "@/lib/briefs-api";
import { assetFileName, fileToBase64 } from "@/components/campaign/editor-state";

function ProductRow({
  product,
  index,
  dispatch,
  uploadingKeys,
  onLogoFile,
  onChooseFromBin,
  errors,
}: {
  product: EditorState["products"][number];
  index: number;
  dispatch: Dispatch<EditorAction>;
  uploadingKeys: ReadonlySet<number>;
  onLogoFile: (key: number, productId: string, file: File) => Promise<void> | void;
  onChooseFromBin: (key: number) => void;
  errors: FieldErrors;
}) {
  const [editingId, setEditingId] = useState(false);
  const hasIdError = Boolean(errors[`product-${index}-id`]);
  const showIdInput = editingId || product.idTouched || hasIdError;

  return (
    <div className="space-y-4 rounded-lg border border-border bg-surface p-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field fieldKey={`product-${index}-name`} label={messages.productNameLabel} error={errors[`product-${index}-name`]}>
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
          {showIdInput ? (
            <Input
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
                type="text"
                aria-label={messages.productIdLabel}
                className="sr-only"
                value={product.id}
                onChange={(e) =>
                  dispatch({ type: "setProduct", key: product.key, patch: { id: e.target.value } })
                }
                tabIndex={-1}
              />
            </div>
          )}
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
}: {
  state: EditorState;
  dispatch: Dispatch<EditorAction>;
  errors: FieldErrors;
}) {
  const [uploadError, setUploadError] = useState<string | undefined>();
  const [uploadingKeys, setUploadingKeys] = useState<ReadonlySet<number>>(new Set());
  const [assetPickerKey, setAssetPickerKey] = useState<number | null>(null);

  const onLogoFile = async (key: number, productId: string, file: File) => {
    setUploadError(undefined);
    setUploadingKeys((prev) => new Set(prev).add(key));
    const name = assetFileName(file.name, productId);
    try {
      const contentBase64 = await fileToBase64(file);
      const { path } = await uploadAsset({
        briefId: state.briefId,
        name,
        contentBase64,
      });
      dispatch({ type: "setProduct", key, patch: { logoPath: path } });
    } catch (error) {
      if (isBriefsApiError(error) && error.status === 409) {
        dispatch({
          type: "setProduct",
          key,
          patch: { logoPath: `assets/inputs/${state.briefId}/${name}` },
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
      {state.mode === "brief" && state.products.length === 1 ? (
        <p className="text-[11px] text-text-muted">
          {messages.productsClassicHint}
        </p>
      ) : null}
      <div className="flex items-center justify-between">
        <h3 className="font-mono text-[11px] uppercase tracking-widest text-text-muted">
          {messages.productsHeading(state.products.length)}
        </h3>
        <Button variant="secondary" size="sm" type="button" onClick={() => dispatch({ type: "addProduct" })}>
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
          onChooseFromBin={(key) => setAssetPickerKey(key)}
          errors={errors}
        />
      ))}

      {assetPickerKey !== null ? (
        <AssetPickerDrawer
          briefId={state.briefId}
          open={true}
          onClose={() => setAssetPickerKey(null)}
          selectedPath={state.products.find((p) => p.key === assetPickerKey)?.logoPath}
          onSelect={(asset) => {
            dispatch({
              type: "setProduct",
              key: assetPickerKey,
              patch: { logoPath: `assets/inputs/${state.briefId}/${asset.name}` },
            });
            setAssetPickerKey(null);
          }}
        />
      ) : null}
    </SectionShell>
  );
}
