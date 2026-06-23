/**
 * Dynamic Client Registration (RFC 7591) — IAT Basic-auth variant.
 *
 * Registration workflow (per project requirements):
 *   - Authenticate to the registration endpoint with HTTP Basic auth, using an
 *     Initial Access Token (IAT) client ID and client secret, both supplied via
 *     environment variables (DCR_CLIENT_ID / DCR_CLIENT_SECRET).
 *   - Send a form-encoded body containing exactly two keys:
 *         grant_type=client_credentials
 *         scope=<DCR_SCOPE>   (defaults to "scope-dcr")
 *   - The response yields the issued client credentials.
 */

import { logger, redact } from "../util/logger.js";
import type { AppConfig } from "../config/index.js";
import type { ClientCredentials } from "./credentialsStore.js";

export class DcrError extends Error {
  readonly status?: number;
  readonly oauthError?: string;
  readonly oauthErrorDescription?: string;

  constructor(message: string, opts?: { status?: number; error?: string; description?: string }) {
    super(message);
    this.name = "DcrError";
    this.status = opts?.status;
    this.oauthError = opts?.error;
    this.oauthErrorDescription = opts?.description;
  }
}

interface RawRegistrationResponse {
  client_id: string;
  client_secret?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
  registration_access_token?: string;
  registration_client_uri?: string;
}

/**
 * Build the form-encoded DCR request body. It contains exactly two keys:
 * grant_type=client_credentials and scope=<dcrScope>.
 */
export function buildRegistrationBody(config: AppConfig): URLSearchParams {
  const params = new URLSearchParams();
  params.set("grant_type", "client_credentials");
  params.set("scope", config.dcrScope);
  return params;
}

/**
 * Build the HTTP Basic Authorization header value from the IAT credentials.
 */
export function buildBasicAuthHeader(clientId: string, clientSecret: string): string {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  return `Basic ${basic}`;
}

/**
 * Parse a registration response into normalized ClientCredentials.
 */
export function parseRegistrationResponse(raw: RawRegistrationResponse): ClientCredentials {
  if (!raw.client_id) {
    throw new DcrError("Registration response did not include a client_id");
  }
  return {
    clientId: raw.client_id,
    clientSecret: raw.client_secret,
    clientIdIssuedAt: raw.client_id_issued_at,
    clientSecretExpiresAt: raw.client_secret_expires_at,
    registrationAccessToken: raw.registration_access_token,
    registrationClientUri: raw.registration_client_uri,
  };
}

/**
 * Register the agent at the AS registration endpoint (RFC 7591) using HTTP
 * Basic auth with the IAT client ID/secret and a form-encoded body.
 */
export async function registerClient(
  registrationEndpoint: string,
  config: AppConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ClientCredentials> {
  if (!config.dcrClientId || !config.dcrClientSecret) {
    throw new DcrError(
      "DCR requires IAT credentials. Set DCR_CLIENT_ID and DCR_CLIENT_SECRET " +
        "(used for HTTP Basic auth on the registration request).",
    );
  }

  const body = buildRegistrationBody(config);
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
    Authorization: buildBasicAuthHeader(config.dcrClientId, config.dcrClientSecret),
  };

  logger.info("Registering client via DCR (IAT Basic auth)", {
    registrationEndpoint,
    dcrClientId: config.dcrClientId,
    scope: config.dcrScope,
  });

  const res = await fetchImpl(registrationEndpoint, {
    method: "POST",
    headers,
    body: body.toString(),
  });

  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new DcrError(`DCR returned non-JSON response (status ${res.status}): ${text.slice(0, 200)}`, {
      status: res.status,
    });
  }

  if (!res.ok) {
    const errObj = json as { error?: string; error_description?: string };
    // Surface the OAuth error; do not retry blindly (per CLAUDE.md table).
    throw new DcrError(
      `DCR failed (${res.status}): ${errObj.error ?? "unknown_error"}` +
        (errObj.error_description ? ` - ${errObj.error_description}` : ""),
      { status: res.status, error: errObj.error, description: errObj.error_description },
    );
  }

  const creds = parseRegistrationResponse(json as RawRegistrationResponse);
  logger.info("DCR succeeded", {
    clientId: creds.clientId,
    clientSecret: redact(creds.clientSecret),
    clientSecretExpiresAt: creds.clientSecretExpiresAt,
  });
  return creds;
}
