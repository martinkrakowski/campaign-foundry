"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { useRun } from "@/lib/run-context";
import { createBrief, isBriefsApiError, unknownErrorMessage } from "@/lib/briefs-api";
import {
  CampaignTypeStep,
  CopyStep,
  OutputStep,
  PolicyStep,
  ProductsStep,
  ReviewStep,
  STEP_TITLES,
} from "./steps";
import { hasErrors, validateStep, type FieldErrors } from "./validate";
import { initialWizardState, stepsFor, toBrief, wizardReducer } from "./wizard-state";

/** Multi-step authoring flow for a new campaign brief. */
export function Wizard() {
  const [state, dispatch] = useReducer(wizardReducer, initialWizardState);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [persistError, setPersistError] = useState<string | undefined>();
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const { setBrief } = useRun();
  const router = useRouter();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);

  const steps = stepsFor(state.mode);
  const stepId = steps[state.stepIndex];
  const last = state.stepIndex >= steps.length - 1;
  const stepProps = { state, dispatch, errors };

  useEffect(() => {
    if (!moved.current) return;
    headingRef.current?.focus();
  }, [state.stepIndex]);

  const goNext = () => {
    const nextErrors = validateStep(stepId, state);
    setErrors(nextErrors);
    if (hasErrors(nextErrors)) return;
    moved.current = true;
    dispatch({ type: "next" });
    setErrors({});
  };

  const goBack = () => {
    moved.current = true;
    dispatch({ type: "back" });
    setErrors({});
    setPersistError(undefined);
    setConflict(false);
  };

  const save = async (replace: boolean) => {
    setSaving(true);
    setPersistError(undefined);
    setConflict(false);
    try {
      const brief = toBrief(state);
      const result = await createBrief(brief, { replace });
      setBrief(result.brief);
      router.push("/brief");
    } catch (error) {
      if (isBriefsApiError(error) && error.status === 409) {
        setConflict(true);
        setPersistError(error.message);
      } else {
        setPersistError(unknownErrorMessage(error, "Save failed"));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-6 overflow-y-auto p-4 pb-12 sm:p-8">
      <div>
        <h2 className="text-xl font-bold text-white">New campaign</h2>
        <p className="text-[13px] text-text-muted">Author a brief, then save it into briefs/.</p>
      </div>

      <ol className="flex flex-wrap gap-2">
        {steps.map((id, index) => (
          <li
            key={id}
            aria-current={index === state.stepIndex ? "step" : undefined}
            className={
              index === state.stepIndex
                ? "font-mono text-[11px] uppercase tracking-widest text-white"
                : "font-mono text-[11px] uppercase tracking-widest text-text-muted"
            }
          >
            {index + 1}. {STEP_TITLES[id]}
          </li>
        ))}
      </ol>

      <h3 ref={headingRef} tabIndex={-1} className="text-sm font-semibold text-white">
        {STEP_TITLES[stepId]}
      </h3>

      {stepId === "type" ? <CampaignTypeStep {...stepProps} /> : null}
      {stepId === "products" ? <ProductsStep {...stepProps} /> : null}
      {stepId === "copy" ? <CopyStep {...stepProps} /> : null}
      {stepId === "policy" ? <PolicyStep {...stepProps} /> : null}
      {stepId === "output" ? <OutputStep {...stepProps} /> : null}
      {stepId === "review" ? <ReviewStep state={state} /> : null}

      {persistError ? <p className="text-[13px] text-error">{persistError}</p> : null}

      <div className="flex flex-wrap gap-3">
        <Button variant="ghost" onClick={goBack} disabled={state.stepIndex === 0 || saving}>
          Back
        </Button>
        {last ? (
          <>
            <Button onClick={() => void save(false)} disabled={saving} isLoading={saving}>
              Save
            </Button>
            {conflict ? (
              <Button variant="secondary" onClick={() => void save(true)} disabled={saving}>
                Replace
              </Button>
            ) : null}
          </>
        ) : (
          <Button onClick={goNext}>Next</Button>
        )}
      </div>
    </div>
  );
}
