import { expect, test } from "vitest";
import { mergeDocuments, planMergedFiles, resolveMerge } from "../src/remote/merge";
import { toPublicationDocument, type PublicationDocument } from "../src/project/publication";
import { editFixture, projectFixture } from "./fixtures";

const project = projectFixture();
const doc = toPublicationDocument(project);
type Chapter = PublicationDocument["chapters"][number];
const page = (id: string, markdown: string): Chapter => ({id, title:id, markdown});
const book = (...chapters: Chapter[]): PublicationDocument => ({...doc,chapters,markdown:chapters.map((ch: Chapter): string => ch.markdown).join("\n\n")});
const single = (markdown: string): PublicationDocument => ({...doc,chapters:[],markdown});

test("different chapters, metadata fields and independent lines retain both sources with exact endings", (): void => {
  const base = book(page("a","one\r\ntwo\r\nthree"),page("b","B"));
  const local = {...book(page("a","ONE\r\ntwo\r\nthree"),page("b","local B")),title:"local title"};
  const remote = {...book(page("a","one\r\ntwo\r\nTHREE"),page("b","B")),authors:"remote authors"};
  const result = mergeDocuments(base,local,remote);
  expect(result.conflicts).toEqual([]);
  expect(resolveMerge(result,{})).toMatchObject({title:local.title,authors:remote.authors,markdown:"ONE\r\ntwo\r\nTHREE\n\nlocal B"});
});
test("two overlapping hunks require individual choices while independent surrounding edits survive", (): void => {
  const result = mergeDocuments(single("a\nb\nc\nd\ne\nf\ng"),single("A\nb\nL\nd\nE\nf\ng"),single("a\nb\nR\nd\nQ\nf\nG"));
  expect(result.conflicts.map((c: {kind:string}): string => c.kind)).toEqual(["text","text"]);
  const [first, second] = result.conflicts;
  expect((): unknown => planMergedFiles(project,result.candidate)).toThrow();
  expect((): unknown => resolveMerge(result,{[first.id]:first.local})).toThrow();
  expect(resolveMerge(result,{[first.id]:first.remote,[second.id]:"custom\n"}).markdown).toBe("A\nb\nR\nd\ncustom\nf\nG");
});
test("deletion versus edit, incompatible permutations and chapter paths are structural", (): void => {
  const [a,b,c] = ["a","b","c"].map((id: string): Chapter => page(id,id));
  const removed = mergeDocuments(book(a,b),book(a),book(a,page("b","changed")));
  expect(removed.conflicts[0].kind).toBe("chapter");
  expect(resolveMerge(removed,{[removed.conflicts[0].id]:null}).chapters).toEqual([a]);
  const order = mergeDocuments(book(a,b,c),book(b,a,c),book(a,c,b));
  expect(order.conflicts.map((x:{kind:string}):string => x.kind)).toEqual(["order"]);
  expect(resolveMerge(order,{[order.conflicts[0].id]:["a","c","b"]}).chapters).toEqual([a,c,b]);
  const changed = editFixture(project,project.config.chapters![0].file,"updated");
  const planned = planMergedFiles(project,toPublicationDocument(changed));
  expect(planned.map((f:{path:string}):string => f.path)).toContain("chapters/z-intro.md");
  expect(planned.some((f:{path:string}):boolean => f.path === "chapters/intro.md")).toBe(false);
});
test("merges entries added at the same position and separate changes within a key, preserving raw YAML", (): void => {
  const bibliography = "# refs\r\na:\r\n  title: 'One' # original\r\n  x-field: unknown\r\n";
  const local = bibliography.replace("'One'","'Two'") + "l:\r\n  title: Local\r\n";
  const remote = bibliography.replace("unknown","updated") + "r:\r\n  title: Remote\r\n";
  const result = mergeDocuments({...doc,bibliography},{...doc,bibliography:local},{...doc,bibliography:remote});
  expect(result.conflicts).toEqual([]);
  expect(resolveMerge(result,{}).bibliography).toBe(local.replace("unknown","updated")+"r:\r\n  title: Remote\r\n");
  const uncertain = mergeDocuments({...doc,bibliography},{...doc,bibliography:local},{...doc,bibliography:bibliography.replace("'One'","'Other'")});
  expect(uncertain.conflicts[0].kind).toBe("bibliography");
});

test("a chapter heading edited in the result is the publication title; an incompatible insertion and move asks for order", (): void => {
  const c = (title:string):Chapter => ({id:"one",title,markdown:"# "+title+"\n"});
  const conflict = mergeDocuments(book(c("Before")),book(c("Local")),book(c("Remote")));
  expect(conflict.conflicts).toHaveLength(1);
  expect(resolveMerge(conflict,{[conflict.conflicts[0].id]:"# Resolved\n"}).chapters[0].title).toBe("Resolved");
  const [a,b,z] = ["a","b","z"].map((id:string):Chapter => page(id,id));
  const order = mergeDocuments(book(a,b),book(b,a),book(a,z,b));
  expect(order.conflicts[0].kind).toBe("order");
});

test("uncertain shared YAML edits retain complete sides for explicit review", (): void => {
  const b = "a:\n  tags: &shared [one]\nb:\n  labels: *shared\n";
  const left = b.replace("one","two"), right = b.replace("labels","keywords");
  const review = mergeDocuments({...doc,bibliography:b},{...doc,bibliography:left},{...doc,bibliography:right});
  expect(review.conflicts[0]).toMatchObject({kind:"bibliography",base:b,local:left,remote:right});
  expect(resolveMerge(review,{[review.conflicts[0].id]:right}).bibliography).toBe(right);
});
