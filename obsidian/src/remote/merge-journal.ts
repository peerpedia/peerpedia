import { basename, join } from "node:path";
import type { AnchoredFiles } from "../project/anchored-files";
import { safePath } from "../project/transaction";
import { RECOVERY_DIR } from "../project/recovery";
import { sourceDigest, type MergeCommit } from "../project/store";
import { decodeBinding, isBindingSuccessor, readVersion, writeVersion } from "./binding";
import { isUuid } from "./links";
import { checksum, object } from "./verify";

interface Intent extends MergeCommit { transaction: string; before: string }
const pending = ".peerpedia-obsidian/merge-pending.json";

export async function stageMerge(tree: AnchoredFiles, root: string, journal: string, before: string, commit: MergeCommit): Promise<string> {
  const {binding,digest,pendingMerge,pendingSubmission} = await readVersion(tree,root);
  const verified = decodeBinding(commit.binding);
  if (pendingSubmission || pendingMerge || digest !== commit.expectedDigest || binding?.origin !== verified.origin || binding.paperId !== verified.paperId)
    throw new Error("本地绑定已更改或合并未完成，请重新核对。");
  const intent: Intent = {...commit,binding:verified,before:checksum(before),revision:checksum(commit.revision),transaction:basename(journal)};
  const stage = join(journal,"merge-intent.json");
  const content = JSON.stringify(intent);
  await tree.file(stage,content);
  tree.rename(stage,join(root,pending),"publish");
  await tree.sync(join(root,".peerpedia-obsidian"));
  return sourceDigest(Buffer.from(content));
}

export async function finishMerge(tree: AnchoredFiles, root: string, revision: string, recover: boolean, expectedId?: string): Promise<void> {
  const record = await tree.source(join(root,pending));
  if (!record) throw new Error("找不到待完成的合并。");
  const raw = object(JSON.parse(record.text));
  if (!isUuid(raw.transaction) || (expectedId && raw.transaction !== expectedId)) throw new Error("合并事务不匹配。");
  const intent: Intent = {transaction:raw.transaction,binding:decodeBinding(raw.binding),expectedDigest:checksum(raw.expectedDigest),
    before:checksum(raw.before),revision:checksum(raw.revision)};
  const journal = join(root,RECOVERY_DIR,intent.transaction);
  const completed = await tree.source(join(journal,"complete"));
  const version = await readVersion(tree,root);
  const source = await tree.source(join(journal,"journal.json"));
  const log = source && object(JSON.parse(source.text));
  if (log && (log.mergeIntent !== record.digest || log.expectedRevision !== intent.before))
    throw new Error("合并来源与文件事务不符，请核对恢复记录。");
  if (!completed) {
    if (!recover || revision !== intent.before || version.digest !== intent.expectedDigest)
      throw new Error("文件事务未完成。请查看恢复文件并核对或还原修改前的文件。");
    if (log) {
      // Manifest-last writes can leave newly created files outside the old
      // membership even when the original project revision still matches.
      for (const [path,digest] of Object.entries(object(log.expected))) {
        safePath(path);
        if ((await tree.source(join(root,path)))?.digest !== (digest === null ? undefined : checksum(digest)))
          throw new Error("文件事务部分写入，请先核对恢复记录：" + path);
      }
    }
  } else {
    if (!log || completed.text !== "ok\n" || revision !== intent.revision)
      throw new Error("合并来源或结果已更改，请核对文件与恢复记录。");
    if (version.digest === intent.expectedDigest) await writeVersion(tree,root,intent.binding,intent.expectedDigest,intent.transaction);
    else if (!await isBindingSuccessor(tree,root,intent.binding,intent.expectedDigest)) throw new Error("合并后绑定已更改，请核对恢复记录。");
  }
  // The unique archive destination makes repeated finalization idempotent with
  // respect to any later pending intent. Keep the link for inspection.
  tree.rename(join(root,pending),join(journal,"merge-intent.json"),"publish");
  await tree.sync(journal);
  await tree.sync(join(root,".peerpedia-obsidian"));
}
