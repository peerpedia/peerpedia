import { UserFacingError } from "../user-error";
import * as http from "node:http";
import * as https from "node:https";
import type { HttpResponse, Transport } from "./types";

const limit = 12 * 1024 * 1024;
const messages = {
  destination: "The request destination does not match the authorized site.",
  redirect: "The site redirected the request. The connection was stopped.",
  timeout: "The network request timed out after 30 seconds.",
  size: "The site response exceeded 12 MiB.",
  network: "Unable to connect. Check the site URL and your network connection.",
};

export class TransportError extends UserFacingError {
  constructor(readonly code: keyof typeof messages) { super(messages[code]); }
}

export function exactOrigin(origin: string): URL {
  let url: URL;
  try { url = new URL(origin); }
  catch { throw new TransportError("destination"); }
  if (url.origin !== origin || (url.protocol !== "https:" && url.protocol !== "http:")) {
    throw new TransportError("destination");
  }
  return url;
}

export class NodeTransport implements Transport {
  constructor(private readonly localTestOrigin?: string) {}

  async request(origin: string, route: string, method: "GET" | "POST", headers: Readonly<Record<string,string>>,
    body: Uint8Array | null): Promise<HttpResponse> {
    const base = exactOrigin(origin);
    const secure = base.protocol === "https:";
    if (!secure && (origin !== this.localTestOrigin || !["127.0.0.1", "[::1]"].includes(base.hostname))) {
      throw new TransportError("destination");
    }
    if (!route.startsWith("/") || route.startsWith("//") || /[\\#\x00-\x20\x7f]/u.test(route)
      || Object.keys(headers).some((name: string): boolean => /^(host|:authority|proxy-authorization)$/i.test(name))) {
      throw new TransportError("destination");
    }
    const url = new URL(route, base);
    if (url.origin !== origin) throw new TransportError("destination");
    return new Promise<HttpResponse>((resolve: (value: HttpResponse) => void, reject: (error: Error) => void): void => {
      let pending: http.ClientRequest;
      const fail = (code: keyof typeof messages): void => {
        clearTimeout(timer);
        reject(new TransportError(code));
        pending?.destroy();
      };
      const timer = setTimeout((): void => fail("timeout"), 30_000);
      try {
        pending = (secure ? https : http).request(url, {method, headers, agent:false}, (response: http.IncomingMessage): void => {
          response.on("error", (): void => fail("network"));
          const status = response.statusCode ?? 0;
          if (status >= 300 && status < 400) { fail("redirect"); return; }
          if (Number(response.headers["content-length"]) > limit) { fail("size"); return; }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer): void => {
            size += chunk.length;
            if (size > limit) { fail("size"); return; }
            chunks.push(chunk);
          });
          response.on("end", (): void => {
            clearTimeout(timer);
            const fields: Record<string,string> = Object.create(null);
            for (const [name, value] of Object.entries(response.headers)) {
              if (value !== undefined) fields[name] = Array.isArray(value) ? value.join(", ") : value;
            }
            resolve({status, headers:fields, body:Buffer.concat(chunks,size)});
          });
        });
        pending.on("error", (): void => fail("network"));
        pending.end(body);
      } catch { fail("network"); }
    });
  }
}
