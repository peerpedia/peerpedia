import { Modal, type App } from "obsidian";
import { connectAccount, DEFAULT_ORIGIN } from "../remote/account";
import type { DeviceCredentials } from "../remote/credentials";
import type { AccountIdentity, AccountInfo, Transport } from "../remote/types";

export class ConnectionModal extends Modal {
  private verified?: AccountInfo;
  private busy = false;
  private message = "";
  private draftOrigin = DEFAULT_ORIGIN;

  constructor(app: App, private identity: AccountIdentity | null,
    private readonly transport: Transport, private readonly credentials: DeviceCredentials,
    private readonly save: (identity: AccountIdentity | null) => Promise<void>) { super(app); }

  override onOpen(): void { this.render(); }

  override onClose(): void { this.contentEl.empty(); }

  private async act(action: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.message = "";
    this.render();
    try { await action(); }
    catch (error: unknown) { this.message = error instanceof Error ? error.message : "账号操作失败。"; }
    finally { this.busy = false; this.render(); }
  }

  private render(): void {
    const el = this.contentEl;
    el.empty();
    this.setTitle("连接 Peerpedia 账号");
    const site = el.createEl("label", {text:"站点地址 "}).createEl("input", {type:"url"});
    site.value = this.identity?.origin ?? this.draftOrigin;
    site.disabled = this.busy || this.identity !== null;
    if (this.identity) el.createEl("p", {text:"用户名：" + this.identity.username});
    const tokenLabel = this.identity ? "访问令牌（留空使用本机令牌） " : "访问令牌 ";
    const secret = el.createEl("label", {text:tokenLabel}).createEl("input", {type:"password"});
    secret.autocomplete = "off";
    secret.disabled = this.busy;
    const connect = el.createEl("button", {text:this.busy ? "处理中…" : "连接并验证账号"});
    connect.disabled = this.busy;
    connect.onclick = (): void => {
      const origin = site.value.trim();
      this.draftOrigin = origin;
      this.verified = undefined;
      const entered = secret.value;
      secret.value = "";
      void this.act(async (): Promise<void> => {
        const token = entered || (this.identity && await this.credentials.read(origin, this.identity.username));
        if (!token) throw new Error("请输入访问令牌。");
        const info = await connectAccount(origin, token, this.transport, this.credentials, this.identity?.username);
        this.verified = info;
        this.identity = {origin, username:info.username};
        await this.save(this.identity);
      });
    };
    if (this.verified && this.identity) {
      const account = this.verified;
      el.createEl("p", {text:"权限：" + (account.scopes.join("、") || "无")});
      el.createEl("p", {text:"令牌到期：" + account.expiresAt});
      el.createEl("p", {text:`协议 ${account.agreement.version}：${account.agreement.accepted ? "已接受" : "未接受"}`});
      const link = el.createEl("a", {text:"查看协议", href:account.agreement.url});
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      const device = this.credentials.persistence(this.identity.origin,this.identity.username) === "keychain";
      el.createEl("p", {text:device ? "令牌已保存到本机钥匙串。" : "令牌仅在本次会话有效，未保存到钥匙串。"});
    }
    if (this.identity) {
      const disconnect = el.createEl("button", {text:"断开并移除本机凭据"});
      disconnect.disabled = this.busy;
      disconnect.onclick = (): void => {
        void this.act(async (): Promise<void> => {
          if (!this.identity) return;
          this.verified = undefined;
          await this.credentials.remove(this.identity.origin, this.identity.username);
          await this.save(null);
          this.identity = null;
          this.message = "已断开并移除本机凭据。";
        });
      };
    }
    if (this.message) el.createEl("p", {text:this.message, attr:{role:"status"}});
  }
}
