/**
 * Global TLS verification bypass.
 *
 * The OAuth Authorization Server and the MCP server both present TLS
 * certificates that are NOT signed by a trusted CA (self-signed / unsigned),
 * so the default certificate verification would reject every HTTPS request.
 *
 * Importing this module (which must happen BEFORE any HTTP request is made)
 * disables TLS certificate verification for the entire process across both:
 *   - undici / global `fetch` (used directly and by the MCP SDK), via a
 *     global dispatcher configured with `rejectUnauthorized: false`.
 *   - Node's built-in `https` / `tls` modules, via
 *     `NODE_TLS_REJECT_UNAUTHORIZED=0`.
 *
 * WARNING: This disables a critical security control. It exposes all outbound
 * HTTPS traffic to man-in-the-middle attacks and must ONLY be used against
 * trusted endpoints in controlled environments.
 */

import { Agent, setGlobalDispatcher } from "undici";
import { logger } from "./logger.js";

// 1) Cover all undici / fetch traffic (including the MCP SDK transport).
setGlobalDispatcher(
  new Agent({
    connect: { rejectUnauthorized: false },
  }),
);

// 2) Cover any code paths that fall back to Node's native https/tls stack.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

logger.warn(
  "TLS certificate verification is DISABLED for all HTTPS requests. " +
    "This is insecure and should only be used against trusted endpoints.",
);
