import type { PeerpediaApi } from "./api";
import type { BindingVersion } from "./binding";
import type { PrHead, RemoteBinding, RemoteCheck } from "./types";

interface CheckStore {
  readBindingVersion(root: string): Promise<BindingVersion>;
  saveBinding(root: string, binding: RemoteBinding, expectedDigest: string | null): Promise<void>;
}

export async function checkRemote(binding: RemoteBinding, api: PeerpediaApi, proposalId: string|undefined = binding.activePr?.id ?? binding.proposalSource?.id): Promise<RemoteCheck> {
  if (api.origin !== binding.origin) throw new Error("所选站点与项目绑定不符。");
  const current = await api.current(binding.paperId);
  const heads = await api.prs(binding.paperId);
  const activePr = proposalId
    ? heads.find((head: PrHead): boolean => head.id === proposalId)
    : heads.find((head: PrHead): boolean => head.submissionId === (binding.lastSubmitted ?? binding.workingBase).submissionId
      && head.hash === (binding.lastSubmitted ?? binding.workingBase).hash);
  if (proposalId && !activePr) throw new Error("已绑定的提案当前不可见，请稍后重新检查。");
  return {current,activePr:activePr ?? null,checkedAt:new Date().toISOString()};
}

export async function checkProject(root: string, api: PeerpediaApi, store: CheckStore, displayedDigest?: string): Promise<RemoteCheck> {
  const {binding,digest} = await store.readBindingVersion(root);
  if (!binding || (displayedDigest !== undefined && displayedDigest !== digest)) throw new Error("项目绑定已更改，请重新打开论文。");
  const observation = await checkRemote(binding,api);
  await store.saveBinding(root,{...binding,checkedAt:observation.checkedAt},digest);
  return observation;
}
