import type { PublicationDocument } from "../project/publication";

export type JsonValue = null | boolean | number | string | JsonValue[] | {[key: string]: JsonValue};

export interface AccountInfo {
  username: string;
  scopes: readonly string[];
  expiresAt: string;
  agreement: {version: string; accepted: boolean; url: string};
}

export interface AccountIdentity {
  origin: string;
  username: string;
}

export interface HttpResponse {
  status: number;
  headers: Readonly<Record<string,string>>;
  body: Uint8Array;
}

export interface Transport {
  request(origin: string, route: string, method: "GET" | "POST", headers: Readonly<Record<string,string>>,
    body: Uint8Array | null): Promise<HttpResponse>;
}

export interface CredentialStore {
  read(origin: string, username: string): Promise<string | null>;
  write(origin: string, username: string, token: string): Promise<void>;
  remove(origin: string, username: string): Promise<void>;
}

export interface VerifiedSnapshot {
  paperId: string;
  submissionId: string;
  publicId: string | null;
  hash: string;
  status: "pending" | "accepted" | "rejected" | "withdrawn" | "superseded";
  document: PublicationDocument;
  manifest: Readonly<Record<string, JsonValue>>;
}

export interface PrHead {
  id: string;
  hash: string;
  submissionId: string;
  owner: string;
  status: Exclude<VerifiedSnapshot["status"], "superseded">;
}

export type RemoteTarget =
  | {kind: "paper"; identifier: string}
  | {kind: "snapshot"; identifier: string; expectedPaperIdentifier?: string};

export interface Category {
  id: string;
  name: string;
}

export interface LicenseOption {
  code: string;
  label: string;
  url: string;
}

export interface RemoteBinding {
  schemaVersion: 1;
  origin: string;
  paperId: string;
  acceptedBase: VerifiedSnapshot;
  workingBase: VerifiedSnapshot;
  lastSubmitted: VerifiedSnapshot | null;
  activePr: PrHead | null;
  checkedAt: string;
}

export interface RemoteCheck {
  current: VerifiedSnapshot;
  activePr: PrHead | null;
  checkedAt: string;
}
