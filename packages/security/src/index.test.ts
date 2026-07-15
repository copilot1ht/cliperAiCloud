import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, generateCliperApiKey, isCliperApiKey, maskCliperApiKey, sha256Hex, signDesktopRequest, verifyCliperApiKey, verifyDesktopRequestSignature } from "./index.js";

const pepper = "p".repeat(40);

describe("Cliper API key security", () => {
  it("generates a clip_sk key and stores a non-reversible hash", () => {
    const material = generateCliperApiKey(pepper);
    expect(isCliperApiKey(material.rawKey)).toBe(true);
    expect(material.secretHash).not.toContain(material.rawKey);
    expect(material.prefix).toBe(material.rawKey.slice(0, 18));
  });

  it("verifies the correct key using constant-time hash comparison", () => {
    const material = generateCliperApiKey(pepper);
    expect(verifyCliperApiKey(material.rawKey, material.secretHash, pepper)).toBe(true);
    expect(verifyCliperApiKey(`${material.rawKey}x`, material.secretHash, pepper)).toBe(false);
  });

  it("masks key values for UI and logs", () => {
    const material = generateCliperApiKey(pepper);
    const masked = maskCliperApiKey(material.rawKey);
    expect(masked).not.toBe(material.rawKey);
    expect(masked).toContain("...");
  });
});

describe("desktop request integrity", () => {
  it("signs the method, path, timestamp, nonce, and content hash", () => {
    const secret = "desktop-signing-secret-that-is-long-enough";
    const input = { method: "post", path: "/v1/chat/completions", timestamp: "1720000000000", nonce: "nonce-a", contentSha256: sha256Hex('{"ok":true}') };
    const signature = signDesktopRequest(secret, input);
    expect(verifyDesktopRequestSignature(secret, input, signature)).toBe(true);
    expect(verifyDesktopRequestSignature(secret, { ...input, nonce: "nonce-b" }, signature)).toBe(false);
  });

  it("encrypts provider secrets with authenticated AES-256-GCM", () => {
    const secret = "provider-encryption-secret-that-is-long-enough";
    const encrypted = encryptSecret("provider-key-value", secret);
    expect(encrypted).not.toContain("provider-key-value");
    expect(decryptSecret(encrypted, secret)).toBe("provider-key-value");
    expect(() => decryptSecret(`${encrypted.slice(0, -2)}aa`, secret)).toThrow();
  });
});
