# Obsidian Remote Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在已可离线使用的插件中加入手动导入、账号连接、版本检查、三方合并、首次发布和提案快照更新。

**Architecture:** TypeScript 客户端直接使用 Peerpedia 现有 API，不依赖系统 Python/CLI。复用本地计划的文件模型、可恢复写入和预览，独立保存插件同步状态。只有明确用户操作可以调用网络；每次提交冻结 payload 与幂等键，先持久化再发送。

**Tech Stack:** 本地计划的 TypeScript/Vitest 工具链、桌面 Node HTTPS、Mac Keychain（小型 Swift Security.framework 辅助程序）、现有 API v1 与 manifest v1–v4。

**Spec:** [已批准设计](../specs/2026-11-23-obsidian-adaptation-design.md)。先完成[本地写作计划](2026-11-23-obsidian-local-authoring.md)任务 1–8。此计划继续使用同一实现工作区。

## Global Constraints

- 网络操作由用户主动检查、导入、连接账号或提交触发；打开论文与日常编辑不检查远程。
- 发布后继续编辑原文件，不为每次修订另建论文副本。
- 再次提交默认向已绑定且仍开放的提案增加快照，也提供新建提案。
- 不提供评审、讨论阅读或回复功能，仅保留版本和提案状态。
- 外部工具变化或本地未保存编辑不能被远程结果静默覆盖。
- 所有新增或修改函数（包括 Swift 辅助程序、内部帮助函数、测试与脚本）明确标注参数类型及返回类型，保留泛型能力；语言不允许返回标注的构造函数除外。
- 保留 CLI 内容文件格式；不读写或覆盖 `.peerpedia/` 和 CLI 凭据。插件使用 `.peerpedia-obsidian/`，不把令牌写入 vault。
- 不改变网站 API 或生产数据来配合插件；真实发布验证只能在隔离测试服务中进行。

## Review Focus

- 链接含恶意主机、跳转、非标准路径或历史快照：站点身份不能被替换，快照身份不能悄悄变成最新（任务 R1–R3）。
- 不同平台换行、中文、emoji 及 manifest 版本：核验原始字节，不用归一化后的内容冒充远程快照（任务 R2）。
- 已提交提案被接受后，本地又有修改：接受基准、提案 head 和本地工作内容保持独立（任务 R4–R5）。
- 断网或响应丢失时继续修改、重启或换账号：重试只发送原冻结请求，不发重复论文或串用身份（任务 R5）。
- 多文件合并中的章节删除/改名/排序、同键文献修改：不丢失任何一边，不把结构冲突误当成纯文本无冲突（任务 R4）。

## 文件布局与接口契约

新增 `obsidian/src/remote/{types.ts,transport.ts,credentials.ts,api.ts,verify.ts,links.ts,binding.ts,import.ts,merge.ts,journal.ts,submit.ts,controller.ts}`，分别负责协议模型、传输、凭据、API、摘要核验、链接、同步状态、导入、合并、请求日志和用户操作编排。UI 在 `src/ui/{connection-modal.ts,import-modal.ts,merge-view.ts,submit-modal.ts}`。任务 Files 中的 `remote/`、`ui/` 相对 `obsidian/src/`，`tests/`、`native/`、`docs/` 相对 `obsidian/`。原本的离线编辑入口不导入会自动运行网络任务的模块。

复用本地计划的 `ProjectStore`、`ProjectSnapshot`、`FileChange`、`PublicationDocument`、`toPublicationDocument` 与 RendererClient。新类型在 `remote/types.ts`：

- `JsonValue = null | boolean | number | string | JsonValue[] | {[key:string]:JsonValue}`。
- `VerifiedSnapshot {paperId:string; submissionId:string; publicId:string|null; hash:string; status:'pending'|'accepted'|'rejected'|'withdrawn'; document:PublicationDocument; manifest:Readonly<Record<string,JsonValue>>}`。由核验器唯一构造；不把任意网络 JSON 强转为此类型。
- `AccountInfo {username:string; scopes:readonly string[]; expiresAt:string; agreement:{version:string; accepted:boolean; url:string}}`。
- `PrHead {id:string; hash:string; submissionId:string; owner:string; status:VerifiedSnapshot['status']}`。
- `RemoteBinding {schemaVersion:1; origin:string; paperId:string; acceptedBase:VerifiedSnapshot; workingBase:VerifiedSnapshot; lastSubmitted:VerifiedSnapshot|null; activePr:PrHead|null; checkedAt:string}`。workingBase 允许指定历史/未接受快照作为本地起点，不能冒充当前接受基准。
- `HttpResponse {status:number; headers:Readonly<Record<string,string>>; body:Uint8Array}`；`Transport.request(origin:string,route:string,method:'GET'|'POST',headers:Readonly<Record<string,string>>,body:Uint8Array|null):Promise<HttpResponse>`。
- `CredentialStore.read(origin:string,username:string):Promise<string|null>`、`write(origin:string,username:string,token:string):Promise<void>`、`remove(origin:string,username:string):Promise<void>`。

账号连接只保存默认 origin 和用户名；每个项目绑定带独立 origin。默认 `https://peerpedia.dev`，测试可注入 loopback HTTP origin。任何 bearer token 均只发送给其已验证的精确 origin。

现有协议锚点：`GET /api/v1/me/`（账号、scope、协议状态）；`papers/<UUID或public_id>/`（当前接受版本）；`submissions/<UUID或public_id>/`（精确快照）；`papers/<UUID>/prs/`（提案状态）；`licenses/`、`categories/`；`POST /api/v1/push/`。本计划不调用评论/评审端点。API 当前不提供渲染能力版本协商，插件不能凭空报告远程渲染版本或保证未知升级后的绝对一致。

## Task R1：手动网络边界与 Mac 凭据存储

**Files:** 创建 `remote/{types.ts,transport.ts,credentials.ts,account.ts}`、`native/keychain.swift`、`ui/connection-modal.ts`、`tests/{transport.test.ts,credentials.test.ts,network-boundary.test.ts}`；扩展打包脚本包含本地 Keychain 辅助程序。`account.ts` 负责账号响应校验与明确连接动作，供 R2 的 `/me/` 读取复用。

**Interfaces:** 实现上文 Transport/CredentialStore；`connectAccount(origin:string,token:string,transport:Transport,credentials:CredentialStore):Promise<AccountInfo>`，仅连接按钮调用。Keychain 辅助程序通过 stdin 读取操作、origin、用户名与 token，使用 Security.framework 的通用密码条目；输出专用结果，不输出调试日志。

- [ ] 前置修复本地总复核遗留的诊断分类回归：将无法解析的内嵌书目与非阻塞的发布兼容性提示明确区分。通过 `validateNewCitationKey`、`previewCitationRename`、`citationImpact` 验证含 wiki 链接或图片的章节仍可管理有效书目，提示仍可见、无关原文保留；真正损坏的内嵌 YAML 继续阻止不可靠的引用重构。此项先修复并验证，再实现本任务的网络入口。
- [ ] 写失败断言：300 系列响应不跟随；任何目标 origin 变化不带凭据；30 秒超时与超过 12 MiB 响应拒绝；令牌不出现在进程参数、vault 内容或日志。模拟 onload、打开论文、编辑和预览时 `expect(transport.request).not.toHaveBeenCalled()`。
- [ ] 运行 `npm --prefix obsidian test -- tests/transport.test.ts tests/credentials.test.ts tests/network-boundary.test.ts` 确认失败。实现 Node HTTPS 请求（不使用自动跟随重定向的封装），精确 origin 校验和结构化错误；HTTP 仅允许显式本地测试目标。
- [ ] 实现 Keychain 辅助程序并为当前 Mac 架构打包，令牌通过 stdin 传递，辅助程序与渲染器职责分离。通过临时测试条目验证读写删除；没有安全凭据能力时允许本次会话内存使用，明确显示未保存，不回退到 vault 明文文件。
- [ ] 连接弹窗调用 `/me/` 验证后才保存身份，显示 scope/到期/协议状态；断开仅移除本机凭据，不删除论文、绑定或代表用户撤销所有令牌。类型检查、本任务测试通过后提交 `feat(obsidian): connect accounts with device credentials`。

## Task R2：版本协议与可验证快照

**Files:** 创建 `remote/{verify.ts,api.ts,links.ts}`、`tests/{protocol.test.ts,links.test.ts}`、`tests/fixtures/manifests/{v1,v2,v3,v4}.json`。

**Interfaces:** `verifySnapshot(raw:unknown):VerifiedSnapshot`；`parseRemoteLink(input:string,origin:string):RemoteTarget`，`RemoteTarget {kind:'paper'|'snapshot'; identifier:string}`；`PeerpediaApi.current(paperId:string):Promise<VerifiedSnapshot>`、`snapshot(id:string):Promise<VerifiedSnapshot>`、`prs(paperId:string):Promise<readonly PrHead[]>`、`me(token:string):Promise<AccountInfo>`、`categories():Promise<readonly Category[]>`、`licenses():Promise<readonly LicenseOption[]>`，`Category {id:string;name:string}`、`LicenseOption {code:string;label:string;url:string}`。API 构造时注入 origin 与 Transport，不在构造函数请求网络。

- [ ] 从隔离服务生成四种版本的固定记录，写失败测试：`verifySnapshot(fixture).hash` 等于 Python CLI 核验的 hash；正文、章节顺序、书目或 manifest 任一改变都拒绝。加入 CRLF、中文、emoji 和无效 UTF-8/代理对案例。
- [ ] 运行 `npm --prefix obsidian test -- tests/protocol.test.ts tests/links.test.ts` 确认失败。按 CLI `verify` 实现 Python 兼容 canonical JSON：排序键、无空白、保留 Unicode、禁止不支持的值；哈希基于原文 bytes。分版本校验字段，不要求历史版本具有后来才新增的字段。
- [ ] 链接解析支持网站现有 paper、submission 和相应 read 链接，以及实际存在的版本阅读链接；校验主机、路径和标识，不从任意网页执行脚本或跟随不明跳转。论文链接调用 current，快照链接调用 snapshot；manifest 提供真实 paper UUID。
- [ ] `prs` 处理分页，只保留身份/head/status 等同步所需字段。网络异常与校验失败保持不同错误。通过测试、类型检查和只读协议 fixture 核对后提交 `feat(obsidian): verify remote paper snapshots`。

## Task R3：论文导入与显式版本检查

**Files:** 创建 `remote/{binding.ts,import.ts,controller.ts}`、`ui/import-modal.ts`、`tests/{import.test.ts,binding.test.ts}`；扩展项目面板的明确操作按钮。

**Interfaces:** `loadBinding(root:string):Promise<RemoteBinding|null>`；`saveBinding(root:string,binding:RemoteBinding,expectedDigest:string|null):Promise<void>`，同步状态也用修订前置检查。`importPaper(target:RemoteTarget,root:string,api:PeerpediaApi,store:ProjectStore):Promise<ProjectSnapshot>`；`checkRemote(binding:RemoteBinding,api:PeerpediaApi):Promise<RemoteCheck>`，`RemoteCheck {current:VerifiedSnapshot; activePr:PrHead|null; checkedAt:string}`。仅用户操作调用 check，不启动计时器。

- [ ] 写失败测试：导入指定旧快照后本地文件等于旧快照，workingBase 为旧快照，acceptedBase 为明确查询到的当前版本；已存在目标目录拒绝导入；远程恶意章节 ID 不能生成越界路径；取消导入不留下半个有效项目。
- [ ] 运行 `npm --prefix obsidian test -- tests/import.test.ts tests/binding.test.ts` 确认失败。以经过校验的章节 ID 生成相对路径，建立 `paper.json`、正文、文献，使用 `ProjectStore.create` 原子创建独立目录，之后持久化插件绑定。
- [ ] 历史快照导入不自动更新其正文。导入单次操作可同时读取 current 以确立接受基准；此后任何拉取必须用户明确触发。当前论文关联提案未知时只显示未检查，不在打开文档时联网补全。
- [ ] 面板显示最后主动检查时间与本地状态；远程 404/隐藏/令牌到期保留所有本地内容。成功通过本任务测试和网络边界测试后提交 `feat(obsidian): import papers and check versions on demand`。

## Task R4：结构化三方合并与确认写入

**Files:** 创建 `remote/merge.ts`、`ui/merge-view.ts`、`tests/{merge.test.ts,merge-apply.test.ts}`。

**Interfaces:** `mergeDocuments(base:PublicationDocument,local:PublicationDocument,remote:PublicationDocument):MergeResult`；`MergeResult {candidate:PublicationDocument; conflicts:readonly MergeConflict[]}`；`MergeConflict {id:string; kind:'text'|'chapter'|'order'|'metadata'|'bibliography'; target:string; base:JsonValue; local:JsonValue; remote:JsonValue}`。`resolveMerge(result:MergeResult,choices:Readonly<Record<string,JsonValue>>):PublicationDocument`；`planMergedFiles(project:ProjectSnapshot,merged:PublicationDocument):readonly FileChange[]`；`applyMerge(project:ProjectSnapshot,changes:readonly FileChange[],check:RemoteCheck,store:ProjectStore,api:PeerpediaApi):Promise<ProjectSnapshot>`。

- [ ] 写失败测试：不同章节的修改自动保留；同一行修改形成冲突；删除与编辑同章冲突；重命名路径保持 ID；双方不同排序必须显示结构冲突；不同 metadata 字段可合并；不同文献键自动合并，同键不同字段按可证明的无冲突规则处理，否则显式冲突。任一冲突未选择时禁止 apply。
- [ ] 运行 `npm --prefix obsidian test -- tests/merge.test.ts tests/merge-apply.test.ts` 确认失败。正文采用经测试的三方文本合并；章节按稳定 ID 匹配，排序单独处理；书目按 YAML 条目处理并保留注释/未知字段，有不确定性的双边结构编辑宁可显示冲突，不猜测覆盖。
- [ ] 区分“远程接受基准变化”和“同一未关闭提案 head 被其他客户端更新”：前者使用对应共同基准，后者使用最近共同提案快照；不能拿网站接受版本误充提案 head 的共同祖先。无法证明祖先关系时保留两份来源并提示人工选择。
- [ ] 合并视图显示旧/本地/远程与结果，支持逐处选择及编辑结果。取消不写文件；确认时重查本地修订和远程 current/head，变化则重新比较。本次用户明确更新操作内允许必要的再次校验。
- [ ] 写入通过 `ProjectStore.apply`，同步状态采用可恢复日志与该文件事务关联；正文写成但状态未完成时下次恢复可确定应完成还是停止，不能把未知结果标成已同步。通过测试、类型检查与真实多文件冲突操作后提交 `feat(obsidian): reconcile local and remote revisions`。

## Task R5：冻结提交、追加提案与可靠重试

**Files:** 创建 `remote/{journal.ts,submit.ts}`、`ui/submit-modal.ts`、`tests/{submit.test.ts,retry.test.ts}`；扩展 controller 和状态模型。

**Interfaces:** `SubmissionIntent = 'publish'|'append-pr'|'new-pr'`；`SubmissionDetails {explanation:string; aiAssisted:boolean}`；`PreparedSubmission {id:string; origin:string; username:string; intent:SubmissionIntent; sourceRevision:string; payloadJson:string; payloadDigest:string}`。`prepareSubmission(project:ProjectSnapshot,binding:RemoteBinding|null,account:AccountInfo,intent:SubmissionIntent,details:SubmissionDetails):PreparedSubmission`；`persistRequest(root:string,request:PreparedSubmission):Promise<void>`；`sendPrepared(root:string,request:PreparedSubmission,token:string,transport:Transport):Promise<VerifiedSnapshot>`；`retryPending(root:string,username:string,token:string,transport:Transport):Promise<VerifiedSnapshot>`。请求 id 是 UUID 幂等键，payloadJson 是冻结字节来源，token 永不持久化在请求中。

- [ ] 写失败测试：初次 payload 的 paper_id/base_hash 为 null；更新提案发送 `pull_request_id` 和完整 64 位 `expected_head`；同账号开放提案默认 append；新建提案不带旧 head；不接受用 stale preview 作为当前文档已校验依据。
- [ ] 运行 `npm --prefix obsidian test -- tests/submit.test.ts tests/retry.test.ts` 确认失败。提交弹窗展示当前确切内容的预览/差异、元数据、许可、说明、AI 辅助选项及公开结果。所需分类/许可信息仅在用户打开此流程后获取，缓存供本地显示。
- [ ] 创建 PreparedSubmission 前完成当前修订的正式渲染/文档校验、账号 scope/协议校验及远程 current/head 检查；点击最终提交前发现本地内容变化则刷新确认内容，不能静默把新文字塞入请求。网站协议须由用户在网站接受，不替用户勾选。
- [ ] 请求先落盘后发送。`Idempotency-Key` 采用已保存 id，原 payload 包含文档、书目和章节，并符合 API 的 base/head/许可约束。验证返回快照与所请求的正文、章节、文献、metadata、论文身份匹配，不只验证快照自身 hash。收到合法回执后保留回执，再完成日志状态。
- [ ] 加入故障测试：服务端成功但响应丢失，随后本地变更并重启，主动重试仍发送逐字节相同 payload/id，远程只有一个新快照；未确定结果时禁止另发新请求；不同用户名重试拒绝；401 更新凭据后重试仍保留原请求；429 不自动定时重发。已明确返回的校验或过期基准拒绝可解除待重试状态，未知结果保留。
- [ ] 新论文成功后建立接受基准；修改提案成功只更新 lastSubmitted/activePr，不把 pending 当 accepted。提案后被接受时保留其后本地修改，并在用户确认更新时正确迁移基准。提案关闭时提供新提案，绝不误追加。通过测试和类型检查提交 `feat(obsidian): publish immutable requests with safe retries`。

## Task R6：完整流程验收与个人试用包

**Files:** 创建 `tests/remote-journey.test.ts`、`tests/fixtures/test-server.ts`、`docs/{remote-acceptance.md,usage.md}`；更新 package 脚本、插件包和本地计划的验收文档。

**Interfaces:** `startFixtureServer():Promise<FixtureServer>`，`FixtureServer {origin:string; close:()=>Promise<void>}`；用于故障注入的接口只存在测试代码。真实协议集成使用独立 Django 测试数据库及测试账号，禁止使用生产账号/令牌。

- [ ] 写完整失败用例：新建两章论文→离线编辑外部修改→本地预览→测试站点首次发布→继续编辑→提案→追加同一提案→测试服务接受→主动检查→保留接受后的本地修改→合并→再次提交；全过程同时断言未明确操作时网络调用数不增加。
- [ ] 运行 `npm --prefix obsidian test -- tests/remote-journey.test.ts`；再针对隔离的真实 Peerpedia API 运行契约测试，确保假服务没有掩盖 UUID/hash、manifest、许可或错误码差异。生产站点只可用于用户主动只读导入验证，不自动发布任何演示内容。
- [ ] 在专用 Obsidian 测试 vault 验证连接、导入、比较、冲突选择、提交确认、手动重试、Keychain 拒绝/缺失和断网恢复。保证 UI 不暴露 token、完整内部请求或与用户无关的实现字段。
- [ ] 运行 `npm --prefix obsidian test`、`npm --prefix obsidian run typecheck`、`npm --prefix obsidian run check:types`、`npm --prefix obsidian run build`、`npm --prefix obsidian run package`；输出包和完整验收记录，标明实际测试的 Mac/Obsidian/runtime 版本与已知限制。
- [ ] 提交 `feat(obsidian): complete manual publication workflow`，提供安装说明和可回退的个人试用包。此时再由用户选择实际使用的 vault；未经选择不修改其已有笔记库或发起真实发表。

## 覆盖核对与依据

设计的导入、手动联网、账号、绑定、三方合并、提案更新、公开提交确认、原请求重试与外部编辑保护均有具体任务；五类 Review Focus 各有测试。内容格式兼容 CLI，不承诺同时运行 CLI 提交与插件提交的透明状态共享。

协议以实施基线的 `publishing/api.py`、`publishing/documents.py`、CLI `verify` 为一手依据；Mac 凭据使用 [Apple Keychain Services](https://developer.apple.com/documentation/security/keychain-services)。文献和编辑功能沿用本地计划的官方资料。所有测试目前是待实现的验收要求，不表示已有插件或测试通过。
