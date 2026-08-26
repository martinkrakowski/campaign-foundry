"use client";

import { useState } from "react";
import type { ChangeEvent, Dispatch } from "react";
import { Button, Input } from "@/components/ui";
import type { EditorState, EditorAction } from "@/components/campaign/editor-state";
import type { FieldErrors } from "@/components/campaign/validate";
import { SectionShell, Field } from "./IdentitySection";
import { uploadAsset, isBriefsApiError, unknownErrorMessage } from "@/lib/briefs-api";
import { assetFileName, fileToBase64 } from "@/components/campaign/editor-state";

export function ProductsSection({ state, dispatch, errors }: { state: EditorState; dispatch: Dispatch<EditorAction>; errors: FieldErrors }) {
  const [uploadError, setUploadError] = useState<string | undefined>();
  const [uploadingKeys, setUploadingKeys] = useState<ReadonlySet<number>>(new Set());

  const onLogoFile = async (key: number, productId: string, event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
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
        setUploadError(unknownErrorMessage(error, "Upload failed"));
      }
    } finally {
      setUploadingKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
    event.target.value = "";
  };

  return (
    <SectionShell id="products" title="3 · Products" errorCount={Object.keys(errors).filter((k) => k.startsWith("product")).length}>
      {errors.products ? <p className="text-[13px] text-error">{errors.products}</p> : null}
      {uploadError ? <p className="text-[13px] text-error">{uploadError}</p> : null}
      <div className="flex items-center justify-between">
        <h3 className="font-mono text-[11px] uppercase tracking-widest text-text-muted">
          Products ({state.products.length})
        </h3>
        <Button variant="secondary" size="sm" onClick={() => dispatch({ type: "addProduct" })}>
          Add product
        </Button>
      </div>
      {state.products.map((product, index) => (
        <div key={product.key} className="space-y-3 rounded-lg border border-border bg-surface p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Name" error={errors[`product-${index}-name`]}>
              <Input
                value={product.name}
                onChange={(e) =>
                  dispatch({ type: "setProduct", key: product.key, patch: { name: e.target.value } })
                }
                invalid={Boolean(errors[`product-${index}-name`])}
              />
            </Field>
            <Field label="ID" error={errors[`product-${index}-id`]}>
              <Input
                value={product.id}
                onChange={(e) =>
                  dispatch({ type: "setProduct", key: product.key, patch: { id: e.target.value } })
                }
                invalid={Boolean(errors[`product-${index}-id`])}
              />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Primary Colour" error={errors[`product-${index}-color`]}>
              <Input
                value={product.primaryColor}
                onChange={(e) =>
                  dispatch({ type: "setProduct", key: product.key, patch: { primaryColor: e.target.value } })
                }
                invalid={Boolean(errors[`product-${index}-color`])}
              />
            </Field>
            <Field label="Logo Path" error={errors[`product-${index}-logo`]}>
              <div className="flex gap-2">
                <Input
                  value={product.logoPath}
                  onChange={(e) =>
                    dispatch({ type: "setProduct", key: product.key, patch: { logoPath: e.target.value } })
                  }
                  invalid={Boolean(errors[`product-${index}-logo`])}
                />
                <input
                  type="file"
                  accept="image/png,image/jpeg"
                  className="hidden"
                  id={`logo-upload-${product.key}`}
                  onChange={(e) => void onLogoFile(product.key, product.id, e)}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => document.getElementById(`logo-upload-${product.key}`)?.click()}
                  disabled={uploadingKeys.has(product.key)}
                >
                  {uploadingKeys.has(product.key) ? "Uploading..." : "Upload"}
                </Button>
              </div>
            </Field>
          </div>
          <Button variant="ghost" size="sm" onClick={() => dispatch({ type: "removeProduct", key: product.key })}>
            Remove
          </Button>
        </div>
      ))}
    </SectionShell>
  );
}
