/**
 * Dynamic Client Registration (RFC 7591) — F5 two-step IAT flow.
 *
 * The F5 AS implements DCR as two HTTP calls:
 *
 *   Step 1 — Obtain an Initial Access Token (IAT):
 *     POST <tokenEndpoint>  (e.g. /f5-oauth2/v1/token)
 *       Authorization: Basic base64(DCR_CLIENT_ID:DCR_CLIENT_SECRET)
 *       Content-Type:  application/x-www-form-urlencoded
 *       body:          grant_type=client_credentials&scope=<DCR_SCOPE>
 *     => { access_token, expires_in, token_type, scope }
 *
 *   Step 2 — Register the client using the IAT as a Bearer token:
 *     POST <registrationEndpoint>  (e.g. /f5-oauth2/v1/register)
 *       Authorization: Bearer <IAT access_token>
 *       Content-Type:  application/json
 *       body:          { client_name, grant_types, redirect_uris, ... }
 *     => { client_id, client_secret, client_secret_expires_at, ... }
 *
 * The Step 2 response yields the long-lived client credentials the agent uses
 * for the actual client_credentials token grant later on.
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

/** Step 1 (IAT) token response from the F5 token endpoint. */
interface RawIatResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

/** Step 2 registration response (RFC 7591). */
interface RawRegistrationResponse {
  client_id?: string;
  client_secret?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
  registration_access_token?: string;
  registration_client_uri?: string;
}

/**
 * Build the Step 1 form-encoded body. It contains exactly two keys:
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
 * Build the Step 2 client metadata document (RFC 7591) sent to the
 * registration endpoint. The scope comes from config; the rest are sensible
 * defaults matching the F5 reference request.
 */
export function buildClientMetadata(config: AppConfig): Record<string, unknown> {
  return {
    client_name: "dcr-mcp-agent",
    grant_types: ["client_credentials", "authorization_code", "implicit", "refresh_token"],
    response_types: ["token", "code"],
    scope: config.dcrScope,
    token_endpoint_auth_method: "client_secret_post",
  };
}

/**
 * Parse the Step 2 registration response into normalized ClientCredentials.
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
 * Read the body of a fetch Response as parsed JSON, throwing a DcrError when
 * the payload is not valid JSON.
 */
async function readJson(res: Response, context: string): Promise<unknown> {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new DcrError(
      `${context} returned non-JSON response (status ${res.status}): ${text.slice(0, 200)}`,
      { status: res.status },
    );
  }
}

/**
 * Step 1: Obtain an Initial Access Token (IAT) from the token endpoint using
 * HTTP Basic auth with the DCR_CLIENT_ID / DCR_CLIENT_SECRET credentials.
 */
export async function obtainInitialAccessToken(
  tokenEndpoint: string,
  config: AppConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!config.dcrClientId || !config.dcrClientSecret) {
    throw new DcrError(
      "DCR requires IAT credentials. Set DCR_CLIENT_ID and DCR_CLIENT_SECRET " +
        "(used for HTTP Basic auth to obtain the Initial Access Token).",
    );
  }

  const body = buildRegistrationBody(config);
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
    Authorization: buildBasicAuthHeader(config.dcrClientId, config.dcrClientSecret),
  };

  logger.info("DCR step 1: obtaining Initial Access Token (IAT)", {
    tokenEndpoint,
    dcrClientId: config.dcrClientId,
    scope: config.dcrScope,
  });

  const res = await fetchImpl(tokenEndpoint, {
    method: "POST",
    headers,
    body: body.toString(),
  });

  const json = (await readJson(res, "IAT request")) as RawIatResponse;

  if (!res.ok || json.error) {
    throw new DcrError(
      `IAT request failed (${res.status}): ${json.error ?? "unknown_error"}` +
        (json.error_description ? ` - ${json.error_description}` : ""),
      { status: res.status, error: json.error, description: json.error_description },
    );
  }

  if (!json.access_token) {
    throw new DcrError("IAT response did not include an access_token", { status: res.status });
  }

  logger.info("DCR step 1 succeeded", {
    iat: redact(json.access_token),
    expiresIn: json.expires_in,
    scope: json.scope,
  });
  return json.access_token;
}

/**
 * Step 2: Register the client at the registration endpoint, presenting the IAT
 * as a Bearer token and a JSON client-metadata body.
 */
export async function registerWithIat(
  registrationEndpoint: string,
  iat: string,
  config: AppConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ClientCredentials> {
  const metadata = buildClientMetadata(config);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${iat}`,
  };

  logger.info("DCR step 2: registering client with IAT (Bearer)", {
    registrationEndpoint,
    scope: config.dcrScope,
  });

  const res = await fetchImpl(registrationEndpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(metadata),
  });

  const json = await readJson(res, "Registration");

  if (!res.ok) {
    const errObj = json as { error?: string; error_description?: string };
    throw new DcrError(
      `DCR failed (${res.status}): ${errObj.error ?? "unknown_error"}` +
        (errObj.error_description ? ` - ${errObj.error_description}` : ""),
      { status: res.status, error: errObj.error, description: errObj.error_description },
    );
  }

  const creds = parseRegistrationResponse(json as RawRegistrationResponse);
  logger.info("DCR step 2 succeeded", {
    clientId: creds.clientId,
    clientSecret: redact(creds.clientSecret),
    clientSecretExpiresAt: creds.clientSecretExpiresAt,
  });
  return creds;
}

/**
 * Full two-step DCR: obtain an IAT (Step 1) then register the client (Step 2).
 *
 * @param registrationEndpoint  The /register endpoint (Step 2).
 * @param tokenEndpoint         The /token endpoint used to mint the IAT (Step 1).
 */
export async function registerClient(
  registrationEndpoint: string,
  tokenEndpoint: string,
  config: AppConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ClientCredentials> {
  const iat = await obtainInitialAccessToken(tokenEndpoint, config, fetchImpl);
  return registerWithIat(registrationEndpoint, iat, config, fetchImpl);
}
