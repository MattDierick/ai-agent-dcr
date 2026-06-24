/**
 * Authorization Server metadata discovery (RFC 8414 / OpenID Connect Discovery).
 *
 * Fetches <issuer>/.well-known/openid-configuration (and falls back to
 * /.well-known/oauth-authorization-server) to obtain endpoints. Explicitly
 * configured overrides take precedence when discovery is unavailable.
 */

import { logger } from "../util/logger.js";
import type { AppConfig } from "../config/index.js";

export interface AsMetadata {
  issuer: string;
  registrationEndpoint: string;
  tokenEndpoint: string;
  jwksUri?: string;
  grantTypesSupported?: string[];
  tokenEndpointAuthMethodsSupported?: string[];
}

export class DiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscoveryError";
  }
}

interface RawMetadata {
  issuer?: string;
  registration_endpoint?: string;
  token_endpoint?: string;
  jwks_uri?: string;
  grant_types_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
}

/**
 * Parse raw AS metadata JSON into a normalized AsMetadata, applying any
 * explicit endpoint overrides from config. Throws if required endpoints
 * (registration + token) cannot be resolved.
 */
export function parseMetadata(raw: RawMetadata, config: AppConfig): AsMetadata {
  const registrationEndpoint = config.registrationEndpoint ?? raw.registration_endpoint;
  const tokenEndpoint = config.tokenEndpoint ?? raw.token_endpoint;

  if (!registrationEndpoint) {
    throw new DiscoveryError(
      "No registration_endpoint found in AS metadata and OAUTH_REGISTRATION_ENDPOINT is not set.",
    );
  }
  if (!tokenEndpoint) {
    throw new DiscoveryError(
      "No token_endpoint found in AS metadata and OAUTH_TOKEN_ENDPOINT is not set.",
    );
  }

  return {
    issuer: raw.issuer ?? config.oauthAsIssuer,
    registrationEndpoint,
    tokenEndpoint,
    jwksUri: raw.jwks_uri,
    grantTypesSupported: raw.grant_types_supported,
    tokenEndpointAuthMethodsSupported: raw.token_endpoint_auth_methods_supported,
  };
}

const WELL_KNOWN_PATHS = [
  "/f5-oauth2/v1/.well-known/openid-configuration",
];

/**
 * Discover AS metadata. Tries the well-known endpoints; if all fail, falls
 * back to explicitly configured endpoints (error if those are also missing).
 */
export async function discoverMetadata(
  config: AppConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<AsMetadata> {
  let lastError: unknown;

  for (const path of WELL_KNOWN_PATHS) {
    const url = `${config.oauthAsIssuer}${path}`;
    try {
      logger.debug("Fetching AS metadata", { url });
      const res = await fetchImpl(url, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        lastError = new DiscoveryError(`Metadata request failed: ${res.status} ${res.statusText}`);
        continue;
      }
      const raw = (await res.json()) as RawMetadata;
      const metadata = parseMetadata(raw, config);
      logger.info("AS metadata discovered", {
        issuer: metadata.issuer,
        registrationEndpoint: metadata.registrationEndpoint,
        tokenEndpoint: metadata.tokenEndpoint,
      });
      return metadata;
    } catch (err) {
      lastError = err;
      logger.debug("Discovery attempt failed", { url, error: (err as Error).message });
    }
  }

  // Fallback: use explicit overrides if both are present.
  if (config.registrationEndpoint && config.tokenEndpoint) {
    logger.warn("AS metadata discovery failed; falling back to configured endpoints");
    return {
      issuer: config.oauthAsIssuer,
      registrationEndpoint: config.registrationEndpoint,
      tokenEndpoint: config.tokenEndpoint,
    };
  }

  throw new DiscoveryError(
    "Could not discover AS metadata and no endpoint overrides configured. " +
      `Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}
