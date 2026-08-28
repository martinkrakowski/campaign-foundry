import { describe, test, expect } from "vitest";
import { nextMock } from "@/__tests__/helpers";
import NewCampaignPage from "../page";

describe("/new", () => {
  test("sends the wizard's old address to the blank editor", () => {
    // The step wizard that lived here is gone (D1: one editor, one route). A bookmark
    // from its lifetime should still land somewhere useful rather than 404.
    NewCampaignPage();
    expect(nextMock().redirect).toHaveBeenCalledWith("/brief/new");
  });
});
