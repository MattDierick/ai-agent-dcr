import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadCredentials,
  saveCredentials,
  areCredentialsValid,
} from "../src/oauth/credentialsStore.js";

const tmpFiles: string[] = [];

function tmpFile(): string {
  const p = join(tmpdir(), `dcr-creds-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  tmpFiles.push(p);
  return p;
}

describe("credentialsStore", () => {
  afterEach(async () => {
    await Promise.all(tmpFiles.map((p) => fs.rm(p, { force: true })));
    tmpFiles.length = 0;
  });

  it("returns null for a missing file", async () => {
    expect(await loadCredentials(tmpFile())).toBeNull();
  });

  it("round-trips credentials with 0600 perms", async () => {
    const path = tmpFile();
    await saveCredentials(path, { clientId: "id", clientSecret: "sec", clientSecretExpiresAt: 0 });

    const loaded = await loadCredentials(path);
    expect(loaded?.clientId).toBe("id");

    const stat = await fs.stat(path);
    // 0o777 mask -> compare the permission bits
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("validates non-expired credentials", () => {
    const now = 1000;
    expect(areCredentialsValid({ clientId: "id", clientSecretExpiresAt: 0 }, now)).toBe(true);
    expect(areCredentialsValid({ clientId: "id", clientSecretExpiresAt: 2000 }, now)).toBe(true);
    expect(areCredentialsValid({ clientId: "id", clientSecretExpiresAt: 500 }, now)).toBe(false);
    expect(areCredentialsValid(null, now)).toBe(false);
  });
});
