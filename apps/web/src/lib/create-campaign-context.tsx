"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { subscribeToSeed } from "./create-campaign";

/**
 * The create moment's two channels in one provider (W1). It holds the create
 * dialog's open state — every entry point runs the dirty guard first and then calls
 * `openCreateDialog` (D67), so the state cannot live in the dialog itself — and the
 * seed channel that carries the dialog's four answers to the blank-route editor.
 *
 * The seed half is the part D64(b) retires (a POST replaces the seed); the dialog and
 * its open state survive that fork, which is why the two share one file named for the
 * moment, not for the seed.
 */
interface CreateCampaignContextValue {
  createDialogOpen: boolean;
  openCreateDialog: () => void;
  closeCreateDialog: () => void;
  /**
   * TM4 — the template library's open state, held here for the same reason the
   * create dialog's is: the left column's entry point runs its own gesture and
   * then asks for the overlay, so the state cannot live in the overlay. It sits
   * beside `createDialogOpen` rather than in the run context because picking a
   * template is part of the create moment the owner's flow describes
   * (static/motion → pick a template), not part of a run.
   */
  templateLibraryOpen: boolean;
  openTemplateLibrary: () => void;
  closeTemplateLibrary: () => void;
  /**
   * Bumped every time a seed is published. The editor reads this as the cue to spend
   * the baton with `takeSeed()` — the provider never consumes the key itself, because
   * a full page load on `/brief/new` must still find it.
   */
  seedVersion: number;
}

/**
 * Defaults rather than throwing, for the reason `SectionModeContext` records: the
 * provider is mounted once in the shell layout, and a consumer rendered on its own
 * (a harness that mounts the shell's parts, not the layout) must still render — its
 * create gesture just has no dialog to open there.
 */
const CreateCampaignContext = createContext<CreateCampaignContextValue>({
  createDialogOpen: false,
  openCreateDialog: () => {},
  closeCreateDialog: () => {},
  templateLibraryOpen: false,
  openTemplateLibrary: () => {},
  closeTemplateLibrary: () => {},
  seedVersion: 0,
});

export function CreateCampaignProvider({ children }: { children: ReactNode }) {
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [templateLibraryOpen, setTemplateLibraryOpen] = useState(false);
  const [seedVersion, setSeedVersion] = useState(0);
  // The writer cannot hear a `storage` event for its own write, so the provider
  // learns of a seed through the module's subscriber set and republishes it here.
  useEffect(() => subscribeToSeed(() => setSeedVersion((version) => version + 1)), []);
  const openCreateDialog = useCallback(() => setCreateDialogOpen(true), []);
  const closeCreateDialog = useCallback(() => setCreateDialogOpen(false), []);
  const openTemplateLibrary = useCallback(() => setTemplateLibraryOpen(true), []);
  const closeTemplateLibrary = useCallback(() => setTemplateLibraryOpen(false), []);
  return (
    <CreateCampaignContext.Provider
      value={{
        createDialogOpen,
        openCreateDialog,
        closeCreateDialog,
        templateLibraryOpen,
        openTemplateLibrary,
        closeTemplateLibrary,
        seedVersion,
      }}
    >
      {children}
    </CreateCampaignContext.Provider>
  );
}

export function useCreateCampaign(): CreateCampaignContextValue {
  return useContext(CreateCampaignContext);
}
