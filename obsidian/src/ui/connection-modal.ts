import { styleModal } from "./controls";
import { UserFacingError } from "../user-error";
import { errorMessage } from "./conflict-modal";
import { Modal, type App } from "obsidian";
import { connectAccount, DEFAULT_ORIGIN } from "../remote/account";
import type { AccountCredentials } from "../remote/host-credentials";
import type { AccountIdentity, AccountInfo, Transport } from "../remote/types";

export class ConnectionModal extends Modal {
  private verified?: AccountInfo;
  private busy = false;
  private message = "";
  private draftOrigin = DEFAULT_ORIGIN;

  constructor(app: App, private identity: AccountIdentity | null,
    private readonly transport: Transport, private readonly credentials: AccountCredentials,
    private readonly save: (identity: AccountIdentity | null, cleanup: readonly AccountIdentity[]) => Promise<void>,
    private cleanup: readonly AccountIdentity[] = []) {
    super(app);
    styleModal(this);
    if (identity) this.cleanup = this.excluding(identity);
  }

  private excluding(target: AccountIdentity): AccountIdentity[] {
    return this.cleanup.filter((item:AccountIdentity):boolean => item.origin !== target.origin || item.username !== target.username);
  }

  private async remember(active: AccountIdentity | null, cleanup: readonly AccountIdentity[]): Promise<void> {
    try { await this.save(active, cleanup); }
    catch (error: unknown) {
      throw new UserFacingError("Unable to save the account settings. Check that the vault is writable.", {cause: error});
    }
    this.identity = active;
    this.cleanup = cleanup;
  }

  override onOpen(): void { this.render(); }

  override onClose(): void { this.contentEl.empty(); }

  private async act(action: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.message = "";
    this.render();
    try { await action(); }
    catch (error: unknown) { this.message = errorMessage(error, "Account operation failed."); }
    finally { this.busy = false; this.render(); }
  }

  private render(): void {
    const el = this.contentEl;
    el.empty();
    this.setTitle(this.identity ? "Peerpedia account" : "Connect Peerpedia");
    const account = this.identity;
    if(account){
      const card=el.createDiv({cls:"peerpedia-account-card"});
      card.createEl("strong",{text:account.username});
      card.createEl("small",{text:account.origin});
    }
    const fields=el.createEl("details",{cls:"peerpedia-account-fields"});
    fields.open=!this.identity;
    fields.createEl("summary",{text:this.identity ? "Update connection details" : "Connection details"});
    const site = fields.createEl("label", {text:"Site URL "}).createEl("input", {type:"url"});
    site.value = this.identity?.origin ?? this.draftOrigin;
    site.disabled = this.busy || this.identity !== null;
    const tokenLabel = this.identity ? "Access token (leave blank to use the saved token) " : "Access token ";
    const secret = fields.createEl("label", {text:tokenLabel}).createEl("input", {type:"password"});
    secret.autocomplete = "off";
    secret.disabled = this.busy;
    const connect = el.createEl("button", {text:this.busy ? "Working…" : (this.identity ? "Verify connection" : "Connect and verify account")});
    connect.addClass("mod-cta");
    connect.disabled = this.busy;
    connect.onclick = (): void => {
      const origin = site.value.trim();
      this.draftOrigin = origin;
      this.verified = undefined;
      const entered = secret.value;
      secret.value = "";
      void this.act(async (): Promise<void> => {
        const token = entered || (this.identity && await this.credentials.read(origin, this.identity.username));
        if (!token) throw new UserFacingError("Enter an access token to reconnect. Tokens from earlier macOS Keychain installations are left unchanged.");
        this.verified = await connectAccount(origin, token, this.transport, this.credentials, this.identity?.username,
          (identity: AccountIdentity): Promise<void> => this.remember(identity, this.excluding(identity)));
      });
    };
    if (this.verified && this.identity) {
      const account = this.verified;
      el.createEl("p", {text:"Permissions: " + (account.scopes.join(", ") || "None")});
      el.createEl("p", {text:"Token expires: " + account.expiresAt});
      el.createEl("p", {text:`Publishing agreement ${account.agreement.version}: ${account.agreement.accepted ? "Accepted" : "Awaiting acceptance"}`});
      const link = el.createEl("a", {text:"View agreement", href:account.agreement.url});
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      const persistence = this.credentials.persistence(this.identity.origin,this.identity.username);
      el.createEl("p", {text:persistence === "session" ? "The token is available for this session only." :
        "The token is stored in Obsidian secret storage for this vault."});
    }
    if (this.identity) {
      const disconnect = el.createEl("button", {text:"Disconnect and remove local credentials"});
      disconnect.disabled = this.busy;
      disconnect.onclick = (): void => {
        void this.act(async (): Promise<void> => {
          if (!this.identity) return;
          this.verified = undefined;
          const previous = this.identity;
          const pending = this.excluding(previous);
          try {
            await this.credentials.remove(previous.origin, previous.username);
            this.message = "Account disconnected and this plugin’s saved token removed. Older macOS Keychain entries are unchanged.";
          } catch {
            pending.push(previous);
            this.message = "The session token was cleared. Retry removing the saved credentials when secret storage is available.";
          }
          await this.remember(null, pending);
        });
      };
    }
    for (const target of this.cleanup) {
      el.createEl("p", {text:`Saved token removal pending for ${target.username} (${target.origin}).`});
      const retry = el.createEl("button", {text:"Retry removing saved credentials"});
      retry.disabled = this.busy;
      retry.onclick = (): void => {
        void this.act(async (): Promise<void> => {
          await this.credentials.remove(target.origin, target.username);
          await this.remember(this.identity, this.excluding(target));
          this.message = "Saved credentials removed.";
        });
      };
    }
    if (this.message) el.createEl("p", {text:this.message, attr:{role:"status"}});
  }
}
