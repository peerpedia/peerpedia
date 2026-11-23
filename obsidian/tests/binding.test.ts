import { mkdir, mkdtemp, rm, symlink, readdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Vault } from "obsidian";
import { afterEach, beforeEach, expect, test } from "vitest";
import { VaultProjectStore } from "../src/host/vault-store";
import { newPaper } from "../src/project/management";
import type { RemoteBinding } from "../src/remote/types";
import { verifySnapshot } from "../src/remote/verify";
import raw from "./fixtures/manifests/v4.json";

let vault: string;
let store: VaultProjectStore;
const base = verifySnapshot(raw);
const binding: RemoteBinding = {schemaVersion:1,origin:"https://fixture.invalid",paperId:base.paperId,
  acceptedBase:base,workingBase:base,lastSubmitted:null,activePr:null,checkedAt:"2026-11-23T00:00:00.000Z"};
const events = {} as Pick<Vault,"on"|"offref">;
beforeEach(async ():Promise<void> => {
  vault = await mkdtemp(join(tmpdir(),"peerpedia-binding-"));
  store = new VaultProjectStore(vault,events);
  await store.create("paper",newPaper("fixture",false));
});
afterEach(async ():Promise<void> => { await rm(vault,{recursive:true,force:true}); });

test("absence, restart, stale revision and competing store instances preserve exactly one winning successor", async ():Promise<void> => {
  expect(await store.loadBinding("paper")).toBeNull();
  await store.saveBinding("paper",binding,null);
  const reopened = new VaultProjectStore(vault,events);
  const first = await reopened.readBindingVersion("paper");
  expect(first.binding).toEqual(binding);
  const a = {...binding,checkedAt:"2026-11-24T00:00:00.000Z"}, b = {...binding,checkedAt:"2026-11-25T00:00:00.000Z"};
  const outcomes = await Promise.allSettled([store.saveBinding("paper",a,first.digest),reopened.saveBinding("paper",b,first.digest)]);
  expect(outcomes.filter((entry:PromiseSettledResult<void>):boolean => entry.status === "fulfilled")).toHaveLength(1);
  await expect(store.saveBinding("paper",binding,first.digest)).rejects.toThrow();
  const second = await reopened.readBindingVersion("paper");
  expect(second.binding?.checkedAt).toBe(outcomes[0].status === "fulfilled" ? a.checkedAt : b.checkedAt);
  await store.saveBinding("paper", binding, second.digest);
  const revisited = await reopened.readBindingVersion("paper");
  expect(revisited.binding).toEqual(first.binding);
  expect(revisited.digest).not.toEqual(first.digest);
  await expect(store.saveBinding("paper",a,first.digest)).rejects.toThrow();
});
test("binding storage refuses an aliased project root and the reserved CLI directory", async ():Promise<void> => {
  await mkdir(join(vault,"outside"));
  await symlink(join(vault,"outside"),join(vault,"alias"));
  await expect(store.saveBinding("alias",binding,null)).rejects.toThrow();
  await expect(store.saveBinding(".peerpedia",binding,null)).rejects.toThrow();
  expect(await readdir(join(vault,"outside"))).toEqual([]);
});

test("timestamp-only checks store a compact successor, and corruption or missing history blocks updates", async ():Promise<void> => {
  await store.saveBinding("paper",binding,null);
  const first = await store.readBindingVersion("paper");
  await store.saveBinding("paper",{...binding,checkedAt:"2026-11-24T01:00:00.000Z"},first.digest);
  const dir = join(vault,"paper/.peerpedia-obsidian/binding-history");
  expect((await readFile(join(dir,"1.json"))).byteLength).toBeLessThan(300);
  const tip = await store.readBindingVersion("paper");
  await writeFile(join(dir,"1.json"),"{}");
  await expect(store.loadBinding("paper")).rejects.toThrow();
  await expect(store.saveBinding("paper",binding,tip.digest)).rejects.toThrow();
  await rm(join(dir,"1.json"));
  await writeFile(join(dir,"2.json"),"{}");
  await expect(store.loadBinding("paper")).rejects.toThrow(/不连续/);
});
