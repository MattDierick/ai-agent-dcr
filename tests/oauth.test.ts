import { describe, it, expect } from "vitest";
import { parseMetadata, discoverMetadata, DiscoveryError } from "../src/oauth/discovery.js";
import { buildRegistrationBody, parseRegistrationResponse, registerClient, DcrError } from "../src/oauth/dcr.js";
import {
  jwtExp,
  selectAuthMethod,
  isTokenValid,
  requestToken,
  TokenError,
  type AccessToken,
} from "../src/oauth/token.js";
import type { AppConfig } from "../src/config/index.js";

const baseConfig: AppConfig = {
  oauthAsIssuer: "https://as.example.com",
  mcpServerUrl: "https://mcp.example.com",
  dcrClientId: "iat-id",
  dcrClientSecret: "iat-secret",
  dcrScope: "scope-",
  mcpToolName: "add",
  mcpToolArgs: { a: 9, b: 7 },
  clientCredentialsPath: ".dcr-credentials.json",
};


/** Build a fake Response object for a stubbed fetch. */
function fakeResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

describe("discovery.parseMetadata", () => {
  it("uses overrides when provided", () => {
    const cfg = { ...baseConfig, registrationEndpoint: "https://x/reg", tokenEndpoint: "https://x/tok" };
    const md = parseMetadata({}, cfg);
    expect(md.registrationEndpoint).toBe("https://x/reg");
    expect(md.tokenEndpoint).toBe("https://x/tok");
  });

  it("throws if no registration endpoint", () => {
    expect(() => parseMetadata({ token_endpoint: "https://x/tok" }, baseConfig)).toThrow(DiscoveryError);
  });

  it("reads endpoints from metadata", () => {
    const md = parseMetadata(
      { registration_endpoint: "https://x/reg", token_endpoint: "https://x/tok", jwks_uri: "https://x/jwks" },
      baseConfig,
    );
    expect(md.jwksUri).toBe("https://x/jwks");
  });
});

describe("discovery.discoverMetadata", () => {
  it("fetches and parses well-known metadata", async () => {
    const fetchImpl = (async () =>
      fakeResponse({
        issuer: "https://as.example.com",
        registration_endpoint: "https://as.example.com/register",
        token_endpoint: "https://as.example.com/token",
      })) as unknown as typeof fetch;
    const md = await discoverMetadata(baseConfig, fetchImpl);
    expect(md.tokenEndpoint).toBe("https://as.example.com/token");
  });

  it("falls back to configured endpoints when discovery fails", async () => {
    const cfg = { ...baseConfig, registrationEndpoint: "https://x/reg", tokenEndpoint: "https://x/tok" };
    const fetchImpl = (async () => fakeResponse("nope", false, 404)) as unknown as typeof fetch;
    const md = await discoverMetadata(cfg, fetchImpl);
    expect(md.registrationEndpoint).toBe("https://x/reg");
  });
});

describe("dcr", () => {
  it("builds a form body with exactly grant_type and scope", () => {
    const body = buildRegistrationBody({ ...baseConfig, dcrScope: "scope-client-ai" });
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("scope")).toBe("scope-client-ai");
    expect([...body.keys()].sort()).toEqual(["grant_type", "scope"]);
  });

  it("parses registration response", () => {
    const creds = parseRegistrationResponse({
      client_id: "abc",
      client_secret: "shh",
      client_secret_expires_at: 0,
    });
    expect(creds.clientId).toBe("abc");
    expect(creds.clientSecret).toBe("shh");
  });

  it("performs the two-step DCR flow (IAT then register)", async () => {
    interface Captured {
      url: string;
      auth: string;
      contentType: string;
      body: string;
    }
    const calls: Captured[] = [];

    const fetchImpl = (async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      calls.push({
        url,
        auth: headers.Authorization ?? "",
        contentType: headers["Content-Type"] ?? "",
        body: String(init.body),
      });
      // Step 1: token endpoint returns the IAT.
      if (url.endsWith("/token")) {
        return fakeResponse({ access_token: "iat-token", token_type: "Bearer", expires_in: 300 });
      }
      // Step 2: register endpoint returns the client credentials.
      return fakeResponse({ client_id: "id1", client_secret: "sec1", client_secret_expires_at: 0 });
    }) as unknown as typeof fetch;

    const creds = await registerClient(
      "https://as.example.com/register",
      "https://as.example.com/token",
      baseConfig,
      fetchImpl,
    );
    expect(creds.clientId).toBe("id1");
    expect(creds.clientSecret).toBe("sec1");
    expect(calls).toHaveLength(2);

    // Step 1: Basic auth with IAT client id/secret + form body.
    const step1 = calls[0]!;
    expect(step1.url).toBe("https://as.example.com/token");
    const expectedBasic = "Basic " + Buffer.from("iat-id:iat-secret").toString("base64");
    expect(step1.auth).toBe(expectedBasic);
    expect(step1.contentType).toBe("application/x-www-form-urlencoded");
    const params = new URLSearchParams(step1.body);
    expect(params.get("grant_type")).toBe("client_credentials");
    expect(params.get("scope")).toBe("scope-client-ai");

    // Step 2: Bearer IAT + JSON body.
    const step2 = calls[1]!;
    expect(step2.url).toBe("https://as.example.com/register");
    expect(step2.auth).toBe("Bearer iat-token");
    expect(step2.contentType).toBe("application/json");
    const jsonBody = JSON.parse(step2.body) as Record<string, unknown>;
    expect(jsonBody.scope).toBe("scope-client-ai");
  });

  it("throws when IAT credentials are missing", async () => {
    const fetchImpl = (async () => fakeResponse({})) as unknown as typeof fetch;
    const cfg = { ...baseConfig, dcrClientId: undefined, dcrClientSecret: undefined };
    await expect(
      registerClient("https://as.example.com/register", "https://as.example.com/token", cfg, fetchImpl),
    ).rejects.toBeInstanceOf(DcrError);
  });

  it("surfaces a Step 1 (IAT) error", async () => {
    const fetchImpl = (async () =>
      fakeResponse({ error: "invalid_client", error_description: "bad iat" }, false, 401)) as unknown as typeof fetch;
    await expect(
      registerClient("https://as.example.com/register", "https://as.example.com/token", baseConfig, fetchImpl),
    ).rejects.toBeInstanceOf(DcrError);
  });

  it("surfaces a Step 2 (register) error", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/token")) {
        return fakeResponse({ access_token: "iat-token", expires_in: 300 });
      }
      return fakeResponse({ error: "invalid_client_metadata" }, false, 400);
    }) as unknown as typeof fetch;
    await expect(
      registerClient("https://as.example.com/register", "https://as.example.com/token", baseConfig, fetchImpl),
    ).rejects.toBeInstanceOf(DcrError);
  });
});



describe("token helpers", () => {
  it("selects client_secret_post by default (F5 requirement)", () => {
    expect(selectAuthMethod()).toBe("client_secret_post");
    expect(selectAuthMethod(["client_secret_post"])).toBe("client_secret_post");
    // Prefer post even when both are advertised.
    expect(selectAuthMethod(["client_secret_basic", "client_secret_post"])).toBe("client_secret_post");
    // Honor basic if it is the only advertised method.
    expect(selectAuthMethod(["client_secret_basic"])).toBe("client_secret_basic");
  });


  it("decodes jwt exp", () => {
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ exp: 1234567890 })).toString("base64url");
    const token = `${header}.${payload}.sig`;
    expect(jwtExp(token)).toBe(1234567890);
    expect(jwtExp("not-a-jwt")).toBeUndefined();
  });

  it("evaluates token validity with skew", () => {
    const now = 1000;
    const valid: AccessToken = { accessToken: "t", tokenType: "Bearer", expiresAt: now + 100 };
    const expiring: AccessToken = { accessToken: "t", tokenType: "Bearer", expiresAt: now + 10 };
    expect(isTokenValid(valid, now)).toBe(true);
    expect(isTokenValid(expiring, now)).toBe(false);
    expect(isTokenValid(null, now)).toBe(false);
  });
});

describe("requestToken", () => {
  it("requests a token with basic auth", async () => {
    let capturedAuth = "";
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      capturedAuth = (init.headers as Record<string, string>).Authorization ?? "";
      return fakeResponse({ access_token: "tok", token_type: "Bearer", expires_in: 3600 });
    }) as unknown as typeof fetch;

    const token = await requestToken(
      "https://as.example.com/token",
      { clientId: "id", clientSecret: "sec" },
      { authMethod: "client_secret_basic" },
      fetchImpl,
    );
    expect(token.accessToken).toBe("tok");
    expect(capturedAuth.startsWith("Basic ")).toBe(true);
  });

  it("uses client_secret_post by default: credentials in body + token_content_type=jwt", async () => {
    let capturedAuth: string | undefined;
    let capturedBody = "";
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      capturedAuth = (init.headers as Record<string, string>).Authorization;
      capturedBody = String(init.body);
      return fakeResponse({ access_token: "tok", token_type: "Bearer", expires_in: 3600 });
    }) as unknown as typeof fetch;

    await requestToken(
      "https://as.example.com/token",
      { clientId: "cid", clientSecret: "csecret" },
      { scope: "scope-client-ai" },
      fetchImpl,
    );

    // No Authorization header for client_secret_post.
    expect(capturedAuth).toBeUndefined();
    const params = new URLSearchParams(capturedBody);
    expect(params.get("grant_type")).toBe("client_credentials");
    expect(params.get("client_id")).toBe("cid");
    expect(params.get("client_secret")).toBe("csecret");
    expect(params.get("scope")).toBe("scope-client-ai");
    expect(params.get("token_content_type")).toBe("jwt");
  });

  it("throws TokenError on invalid_client", async () => {
    const fetchImpl = (async () =>
      fakeResponse({ error: "invalid_client" }, false, 401)) as unknown as typeof fetch;
    await expect(
      requestToken("https://as.example.com/token", { clientId: "id", clientSecret: "sec" }, {}, fetchImpl),
    ).rejects.toBeInstanceOf(TokenError);
  });
});

