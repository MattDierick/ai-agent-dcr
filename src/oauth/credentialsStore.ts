/**
 * Persistent cache for DCR client credentials.
 *
 * Credentials are written with restrictive permissions (0600) per the
 * CLAUDE.md security requirements, and never logged.
 */

import { promises as fs } from "node:fs";
import { logger, redact } from "../util/logger.js";

export interface ClientCredentials {
  clientId: string;
  clientSecret?: string;
  /** Unix epoch seconds when the client_id was issued (RFC 7591). */
  clientIdIssuedAt?: number;
  /** Unix epoch seconds when the secret expires; 0 means "never". */
  clientSecretExpiresAt?: number;
  /** RFC 7592 management token. */
  registrationAccessToken?: string;
  /** RFC 7592 management URI. */
  registrationClientUri?: string;
}

/**
 * Load cached credentials from disk, or null if none exist / unreadable.
 */
export async function loadCredentials(path: string): Promise<ClientCredentials | null> {
  try {
    const data = await fs.readFile(path, "utf8");
    const parsed = JSON.parse(data) as ClientCredentials;
    if (!parsed.clientId) return null;
    logger.debug("Loaded cached DCR credentials", {
      path,
      clientId: parsed.clientId,
      clientSecret: redact(parsed.clientSecret),
    });
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Persist credentials to disk with 0600 permissions.
 */
export async function saveCredentials(path: string, creds: ClientCredentials): Promise<void> {
  const json = JSON.stringify(creds, null, 2);
  await fs.writeFile(path, json, { mode: 0o600 });
  // Ensure perms even if the file already existed with looser permissions.
  await fs.chmod(path, 0o600).catch(() => undefined);
  logger.debug("Saved DCR credentials", { path, clientId: creds.clientId });
}

/**
 * Determine whether cached credentials are still usable.
 * Re-registration is required if there is no clientId, or the secret has
 * expired (clientSecretExpiresAt is a non-zero epoch that is in the past).
 */
export function areCredentialsValid(
  creds: ClientCredentials | null,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!creds || !creds.clientId) return false;
  const exp = creds.clientSecretExpiresAt;
  if (exp && exp > 0 && exp <= nowSeconds) {
    return false;
  }
  return true;
}
