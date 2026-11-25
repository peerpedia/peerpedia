import { vi } from "vitest";

// Node-owned timers outlive popout windows. Route them through Vitest's clock in tests.
vi.mock("node:timers", async (): Promise<typeof import("node:timers")> => {
  const actual = await vi.importActual<typeof import("node:timers")>("node:timers");
  return { ...actual, get setTimeout(): typeof setTimeout { return globalThis.setTimeout; },
    get clearTimeout(): typeof clearTimeout { return globalThis.clearTimeout; } };
});
