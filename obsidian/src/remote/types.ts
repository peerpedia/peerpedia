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
