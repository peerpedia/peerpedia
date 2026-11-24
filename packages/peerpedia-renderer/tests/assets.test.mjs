import assert from "node:assert/strict";
import test from "node:test";
import engine from "node-tikzjax";

test("embedded resources replace filesystem loading and initialize only once", /** @returns {Promise<void>} */ async () => {
  let loads = 0;
  engine.setAssetLoader(
    /** @returns {Promise<{core:Uint8Array,wasm:Uint8Array,readFile:(name:string)=>Uint8Array}>} */ async () => {
      loads++;
      return {
        core: new Uint8Array([1]),
        wasm: new Uint8Array([2]),
        /** @param {string} name @returns {Uint8Array} */
        readFile: (name) => {
          assert.equal(name, "/tex_files/example.tex");
          return new TextEncoder().encode("embedded resource");
        },
      };
    },
  );
  await engine.load();
  await engine.load();
  assert.equal(loads, 1);
  assert.equal(
    new TextDecoder().decode(
      engine.dumpMemfs().readFileSync("/tex_files/example.tex"),
    ),
    "embedded resource",
  );
  assert.throws(
    /** @returns {void} */ () =>
      engine.setAssetLoader(
        /** @returns {Promise<never>} */ async () => {
          throw new Error("unused");
        },
      ),
    /initialized/,
  );
});
