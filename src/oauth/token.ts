/**
 * Token acquisition (RFC 6749 client_credentials grant) with caching/refresh.
 *
 * Authenticates with client_secret_basic by default (or client_secret_post if
 * the AS advertises only that). Caches the access token and proactively
 * refreshes it before expiry (with a safety skew).
 */

import { logger, redact } from "../util/logger.js";
import type { ClientCredentials } from "./credentialsStore.js";

/** Refresh tokens this many seconds before their actual expiry. */
const EXPIRY_SKEW_SECONDS = 45;

export type TokenAuthMethod = "client_secret_basic" | "client_secret_post";

export class TokenError extends Error {
  readonly status?: number;
  readonly oauthError?: string;

  constructor(message: string, opts?: { status?: number; error?: string }) {
    super(message);
    this.name = "TokenError";
    this.status = opts?.status;
    this.oauthError = opts?.error;
  }
}

export interface AccessToken {
  accessToken: string;
  tokenType: string;
  /** Unix epoch seconds when the token expires (0 if unknown). */
  expiresAt: number;
  scope?: string;
}

interface RawTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

/**
 * Decode a JWT's `exp` claim (epoch seconds) without verifying the signature.
 * Returns undefined if the token is not a parseable JWT or lacks `exp`.
 */
export function jwtExp(token: string): number | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
      exp?: number;
    };
    return typeof payload.exp === "number" ? payload.exp : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Choose the token endpoint auth method based on what the AS supports.
 * Defaults to client_secret_basic unless the AS advertises only post.
 */
export function selectAuthMethod(supported?: string[]): TokenAuthMethod {
  if (supported && supported.length > 0) {
    if (supported.includes("client_secret_basic")) return "client_secret_basic";
    if (supported.includes("client_secret_post")) return "client_secret_post";
  }
  return "client_secret_basic";
}

/**
 * Is the cached token still valid (accounting for the safety skew)?
 */
export function isTokenValid(
  token: AccessToken | null,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!token || !token.accessToken) return false;
  if (token.expiresAt === 0) return true; // unknown expiry; assume valid
  return token.expiresAt - EXPIRY_SKEW_SECONDS > nowSeconds;
}

/**
 * Request an access token via the client_credentials grant.
 */
export async function requestToken(
  tokenEndpoint: string,
  creds: ClientCredentials,
  options: { scope?: string; authMethod?: TokenAuthMethod },
  fetchImpl: typeof fetch = fetch,
): Promise<AccessToken> {
  const authMethod = options.authMethod ?? "client_secret_basic";
  const params = new URLSearchParams();
  params.set("grant_type", "client_credentials");
  if (options.scope) params.set("scope", options.scope);

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };

  if (authMethod === "client_secret_basic") {
    const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret ?? ""}`).toString("base64");
    headers.Authorization = `Basic ${basic}`;
  } else {
    params.set("client_id", creds.clientId);
    if (creds.clientSecret) params.set("client_secret", creds.clientSecret);
  }

  logger.info("Requesting access token", { tokenEndpoint, authMethod });
  const res = await fetchImpl(tokenEndpoint, {
    method: "POST",
    headers,
    body: params.toString(),
  });

  const text = await res.text();
  let json: RawTokenResponse;
  try {
    json = JSON.parse(text) as RawTokenResponse;
  } catch {
    throw new TokenError(`Token endpoint returned non-JSON (status ${res.status})`, {
      status: res.status,
    });
  }

  if (!res.ok || json.error) {
    throw new TokenError(
      `Token request failed (${res.status}): ${json.error ?? "unknown_error"}` +
        (json.error_description ? ` - ${json.error_description}` : ""),
      { status: res.status, error: json.error },
    );
  }

  if (!json.access_token) {
    throw new TokenError("Token response did not include an access_token");
  }

  const now = Math.floor(Date.now() / 1000);
  const expFromJwt = jwtExp(json.access_token);
  const expFromResponse = json.expires_in ? now + json.expires_in : undefined;
  const expiresAt = expFromJwt ?? expFromResponse ?? 0;

  const token: AccessToken = {
    accessToken: json.access_token,
    tokenType: json.token_type ?? "Bearer",
    expiresAt,
    scope: json.scope,
  };

  logger.info("Access token acquired", {
    tokenType: token.tokenType,
    accessToken: redact(token.accessToken),
    expiresAt: token.expiresAt,
    scope: token.scope,
  });
  return token;
}
