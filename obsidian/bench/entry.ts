import { benchmark } from "./bench";
import { cancellation } from "./cancel";
Object.assign(globalThis, {
  async peerpediaBenchmark(): Promise<Record<string, unknown>[]> {
    return [...(await benchmark()), ...(await cancellation())];
  },
});
