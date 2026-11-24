import { setAssetLoader } from "node-tikzjax";
import { Buffer } from "buffer";
import { loadAssets } from "./assets";
import "peerpedia-tikz-worker";

setAssetLoader(
  async (): Promise<{
    core: Uint8Array;
    wasm: Uint8Array;
    readFile: (name: string) => Uint8Array;
  }> => {
    const assets = await loadAssets();
    return {
      core: assets.core,
      wasm: assets.wasm,
      readFile(name: string): Uint8Array {
        if (!(name in assets.files))
          throw new Error("Missing TeX resource: " + name);
        return Buffer.from(assets.files[name], "base64");
      },
    };
  },
);
