import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Carry dependency and embedded-font notices inside the standard three-file distribution. */
export async function bundleNotices(inputs: readonly string[], theme: string): Promise<string> {
  const roots = new Set<string>();
  for (const input of inputs) {
    const match = /^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)(?:\/|$)/.exec(resolve(input));
    if (match) roots.add(match[1]);
  }
  const sections: string[] = [await readFile("../LICENSE", "utf8")];
  for (const root of [...roots].sort()) {
    const metadata: {name:string;version:string} = JSON.parse(await readFile(join(root,"package.json"),"utf8"));
    const licenses = (await readdir(root)).filter((name:string):boolean=>/^(?:licen[sc]e|copying|notice)(?:[._-]|$)/i.test(name));
    if (!licenses.length) {
      // boolbase 1.0.0 omits its upstream ISC license file from the npm tarball.
      if (metadata.name !== "boolbase" || metadata.version !== "1.0.0") throw new Error("Missing bundled license: " + metadata.name);
      sections.push("boolbase 1.0.0\n" + await readFile("licenses/boolbase-1.0.0-LICENSE.txt","utf8"));
    }
    for (const name of licenses) sections.push(metadata.name + " " + metadata.version + "\n" + await readFile(join(root,name),"utf8"));
  }
  const assets: {katex:{license:string;stylesheetLicense:string};tikz:{license:string};bananaMark:{license:string}} =
    JSON.parse(await readFile(join(theme,"assets.json"),"utf8"));
  for (const name of [assets.katex.license,assets.katex.stylesheetLicense,assets.tikz.license,assets.bananaMark.license]) {
    sections.push(name + "\n" + await readFile(join(theme,name),"utf8"));
  }
  return "\n/*! Third-party notices\n" + sections.join("\n\n").replaceAll("*/", "* /") + "\n*/\n";
}
