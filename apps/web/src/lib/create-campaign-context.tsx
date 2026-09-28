"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

/**
 * The create moment's dialog channel (W1): it holds the create dialog's open
 * state, since every entry point runs the dirty guard first and then calls
 * `openCreateDialog` (D67), so the state cannot live in the dialog itself.
 *
 * PT-5c1 (D64(b), D177) retired the seed channel this provider used to carry
 * alongside it: `cf:create-seed`'s publish/spend cycle existed because a
 * blank create had nothing server-side to load yet, so the dialog's answers
 * rode `localStorage` to the blank-route editor's mount effect. `POST
 * /campaigns` now mints the campaign before any navigation happens, so
 * `/brief/<campaignId>` has a real campaign to fetch (`GET /campaigns/:id`)
 * — there is nothing left for a seed to carry.
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
});

export function CreateCampaignProvider({ children }: { children: ReactNode }) {
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [templateLibraryOpen, setTemplateLibraryOpen] = useState(false);
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
      }}
    >
      {children}
    </CreateCampaignContext.Provider>
  );
}

export function useCreateCampaign(): CreateCampaignContextValue {
  return useContext(CreateCampaignContext);
}
