import { expect, test } from "vitest";
import { parseRemoteLink } from "../src/remote/links";

const origin = "https://fixture.example";
const uuid = "12345678-abcd-4321-9876-123456789abc";
const label = "240229.0123456789ab";

test("parses the site's details and reader routes without requesting or forwarding reader options", (): void => {
  for (const id of [uuid, label]) {
    for (const suffix of ["/", "/read/", "/read/?page=intro#section"]) {
      expect(parseRemoteLink(origin + "/papers/" + id + suffix, origin)).toEqual({kind: "paper", identifier: id});
      expect(parseRemoteLink(origin + "/submissions/" + id + suffix, origin)).toEqual({kind: "snapshot", identifier: id});
    }
  }
  expect(parseRemoteLink(origin + "/papers/" + label + "/versions/" + uuid + "/read/", origin))
    .toEqual({kind: "snapshot", identifier: uuid, expectedPaperIdentifier: label});
});

test("rejects outside sites, invalid calendar dates, unsupported converters and non-reader actions", (): void => {
  for (const url of [
    "https://elsewhere.example/papers/" + uuid + "/", "https://elsewhere.example@" + origin.slice(8) + "/papers/" + uuid + "/",
    origin + ":8443/papers/" + uuid + "/", origin + "/papers/230229.0123456789ab/", origin + "/papers/240231.0123456789ab/",
    origin + "/papers/240229.0123456789AB/", origin + "/submissions/" + uuid + "/comment/",
    origin + "/papers/" + uuid + "/versions/" + uuid + "/read/", origin + "/papers/" + label + "/versions/" + label + "/read/",
    origin + "/random/../papers/" + uuid + "/", origin + "/papers/" + uuid + "%2fread/",
    origin + "/papers/" + uuid + "\n/", "javascript:alert(1)", "//fixture.example/papers/" + uuid + "/",
  ]) expect((): unknown => parseRemoteLink(url, origin), url).toThrow();
});
