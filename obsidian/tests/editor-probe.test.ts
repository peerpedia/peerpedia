import { expect, test } from "vitest";

import { probeCompletions } from "../src/language/probe";

test("suggests theorem after a directive prefix", (): void => {
  expect(probeCompletions(":::th", 5, false)).toContain("theorem");
});

test("suppresses suggestions during composition", (): void => {
  expect(probeCompletions(":::th", 5, true)).toEqual([]);
});

test("uses UTF-16 offsets after a supplementary character", (): void => {
  expect(probeCompletions("😀\n:::th", 8, false)).toContain("theorem");
  expect(probeCompletions("😀\n:::th", 6, false)).toEqual([]);
});

test("ignores inline text and unrelated directives", (): void => {
  expect(probeCompletions("text :::th", 10, false)).toEqual([]);
  expect(probeCompletions(":::there", 8, false)).toEqual([]);
});
