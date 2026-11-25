import { setAssetLoader } from "node-tikzjax";
import { loadAssets, type CoreSnapshot } from "./assets";
import "peerpedia-tikz-worker";

setAssetLoader(
  async (): Promise<{
    core: CoreSnapshot;
    wasm: Uint8Array;
    readFile: (name: string) => Uint8Array;
  }> => {
    const assets = await loadAssets();
    return {
      core: assets.core,
      wasm: assets.wasm,
      readFile(name: string): Uint8Array {
        if (!Object.hasOwn(assets.files, name))
          throw new Error("Missing TeX resource: " + name);
        // TeX can reopen a loaded file for writing. Keep the archive immutable
        // across compilations, as the former base64 decoding did on each read.
        return Uint8Array.from(assets.files[name]);
      },
    };
  },
);
