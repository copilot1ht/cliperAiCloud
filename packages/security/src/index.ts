import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface CliperKeyMaterial {
  rawKey: string;
  prefix: string;
  secretHash: string;
}

export function isCliperApiKey(value: string): boolean {
  return /^clip_sk_[A-Za-z0-9_-]{24,}$/.test(String(value || ""));
}

export function hashCliperApiKey(rawKey: string, pepper: string): string {
  if (!isCliperApiKey(rawKey)) throw new Error("Format Cliper API key tidak valid.");
  if (String(pepper || "").length < 32) throw new Error("API key pepper minimal 32 karakter.");
  return createHmac("sha256", pepper).update(rawKey).digest("hex");
}

export function generateCliperApiKey(pepper: string): CliperKeyMaterial {
  const rawKey = `clip_sk_${randomBytes(24).toString("base64url")}`;
  return {
    rawKey,
    prefix: rawKey.slice(0, 18),
    secretHash: hashCliperApiKey(rawKey, pepper),
  };
}

export function verifyCliperApiKey(rawKey: string, expectedHash: string, pepper: string): boolean {
  try {
    const actual = Buffer.from(hashCliperApiKey(rawKey, pepper), "hex");
    const expected = Buffer.from(expectedHash, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function maskCliperApiKey(rawKey: string): string {
  if (!isCliperApiKey(rawKey)) return "invalid-key";
  return `${rawKey.slice(0, 15)}...${rawKey.slice(-4)}`;
}

export interface SignedRequestInput {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  contentSha256: string;
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalSignedRequest(input: SignedRequestInput): string {
  return [input.method.toUpperCase(), input.path, input.timestamp, input.nonce, input.contentSha256.toLowerCase()].join("\n");
}

export function signDesktopRequest(secret: string, input: SignedRequestInput): string {
  if (String(secret || "").length < 32) throw new Error("Signing secret minimal 32 karakter.");
  return createHmac("sha256", secret).update(canonicalSignedRequest(input)).digest("hex");
}

export function verifyDesktopRequestSignature(secret: string, input: SignedRequestInput, signature: string): boolean {
  try {
    const actual = Buffer.from(signDesktopRequest(secret, input), "hex");
    const expected = Buffer.from(String(signature || ""), "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export interface EncryptedSecretEnvelope {
  version: 1;
  iv: string;
  authTag: string;
  ciphertext: string;
}

function encryptionKey(secret: string): Buffer {
  if (String(secret || "").length < 32) throw new Error("Encryption secret minimal 32 karakter.");
  return createHash("sha256").update(secret).digest();
}

export function encryptSecret(value: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const envelope: EncryptedSecretEnvelope = {
    version: 1,
    iv: iv.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}

export function decryptSecret(encrypted: string, secret: string): string {
  const envelope = JSON.parse(Buffer.from(encrypted, "base64url").toString("utf8")) as EncryptedSecretEnvelope;
  if (envelope.version !== 1) throw new Error("Versi encrypted secret tidak didukung.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(secret), Buffer.from(envelope.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(envelope.authTag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final()]).toString("utf8");
}
