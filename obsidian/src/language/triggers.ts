export const environmentPrefix = /^([ \t]*(?:>[ \t]*)*)(:{3,})([ \t]*)([\w-]*)(?:[ \t]+(.*))?$/;
export const blockPrefix = /^([ \t]*(?:>[ \t]*)*)(`{3,}|~{3,})([\w-]*)$/;
export const texPrefix = /(?:\\begin\{[a-zA-Z*]*|\\[a-zA-Z]+)$/;
export const referencePrefix = /(?:\{@|(?<![\p{L}\p{N}_@./%+\\])@)[^\s#@{}<>[\]|\\`()，。．；：！？、‘’“”（）［］｛｝【】「」『』]*$/u;

type Trigger = "environment" | "block" | "formula" | "reference";

export function completionTrigger(before: string, explicit: boolean): Trigger | null {
  if (blockPrefix.test(before)) return "block";
  if (texPrefix.test(before)) return "formula";
  const environment = environmentPrefix.exec(before);
  if (environment && !environment[5]?.includes("[") && (environment[4] || explicit)) return "environment";
  return referencePrefix.test(before) ? "reference" : null;
}
