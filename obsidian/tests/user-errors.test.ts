import { expect, test, vi } from "vitest";
import { checkAccount } from "../src/remote/submit";
import { errorMessage } from "../src/ui/conflict-modal";
import { account } from "./fixtures/publishing";

vi.mock("obsidian", (): { Modal: typeof Object } => ({ Modal: Object }));

test("shows the English explanation when a submission needs a different account", (): void => {
  try {
    checkAccount(account, "other-account", "publish");
  } catch (error: unknown) {
    expect(errorMessage(error)).toMatch(/different account/i);
    return;
  }
  throw new Error("The submission accepted a token for a different account.");
});

test("keeps raw helper and file system errors out of the interface", (): void => {
  const detail = "EACCES: /private/书目/metadata.json, Authorization: Bearer fixture-secret";
  expect(errorMessage(new Error(detail))).not.toMatch(/private|fixture-secret|Authorization/i);
});
