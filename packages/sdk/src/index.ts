import type { CliperChatRequest, CliperChatResponse, DesktopActivateRequest, DesktopHeartbeatResponse, DesktopSessionResponse, LicenseValidationRequest, LicenseValidationResponse } from "@cliper/contracts";
import { sha256Hex, signDesktopRequest, verifyDesktopRequestSignature } from "@cliper/security";

export interface CliperCloudClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  retries?: number;
}

type AuthMode = "none" | "license" | "session";

export class CliperCloudClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private session?: DesktopSessionResponse;

  constructor(options: CliperCloudClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 45000;
    this.retries = options.retries ?? 2;
  }

  async activateDesktop(request: DesktopActivateRequest): Promise<DesktopSessionResponse> {
    const session = await this.request<DesktopSessionResponse>("/api/auth/desktop/activate", request, "none");
    this.session = session;
    return session;
  }

  async refreshDesktop(deviceFingerprint: string): Promise<DesktopSessionResponse> {
    if (!this.session) throw new Error("Desktop session belum diaktifkan.");
    const session = await this.request<DesktopSessionResponse>("/api/auth/desktop/refresh", { refreshToken: this.session.refreshToken, deviceFingerprint }, "none");
    this.session = session;
    return session;
  }

  heartbeat(): Promise<DesktopHeartbeatResponse> {
    if (!this.session) throw new Error("Desktop session belum diaktifkan.");
    return this.request<DesktopHeartbeatResponse>("/api/auth/desktop/heartbeat", {}, "session");
  }

  chat(request: CliperChatRequest): Promise<CliperChatResponse> {
    return this.request<CliperChatResponse>("/v1/chat/completions", request, this.session ? "session" : "license", true);
  }

  validateLicense(request: LicenseValidationRequest): Promise<LicenseValidationResponse> {
    return this.request("/v1/licenses/validate", request, "none");
  }

  verifyDesktop(request: LicenseValidationRequest): Promise<LicenseValidationResponse & { status?: string }> {
    return this.request("/api/auth/verify", request, "none");
  }

  currentSession(): DesktopSessionResponse | undefined {
    return this.session ? { ...this.session, license: { ...this.session.license, deviceSlots: { ...this.session.license.deviceSlots } } } : undefined;
  }

  private async request<T>(path: string, body: unknown, authMode: AuthMode, verifyIntegrity = false): Promise<T> {
    let lastError: unknown;
    const bodyText = JSON.stringify(body ?? {});
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (authMode === "license") headers.Authorization = `Bearer ${this.apiKey}`;
        if (authMode === "session") Object.assign(headers, this.signedHeaders(path, bodyText));
        const response = await fetch(`${this.baseUrl}${path}`, { method: "POST", headers, body: bodyText, signal: controller.signal });
        const payload = await response.json() as T & { message?: string };
        if (!response.ok) throw new Error(payload.message ?? `Cloud request gagal (HTTP ${response.status}).`);
        if (verifyIntegrity && authMode === "session") this.verifyResponse(path, payload as unknown as CliperChatResponse);
        return payload;
      } catch (error) {
        lastError = error;
        if (attempt < this.retries) await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Cloud request gagal.");
  }

  private signedHeaders(path: string, bodyText: string): Record<string, string> {
    if (!this.session) throw new Error("Desktop session belum diaktifkan.");
    const timestamp = String(Date.now());
    const nonce = crypto.randomUUID().replace(/-/g, "");
    const contentSha256 = sha256Hex(bodyText);
    const signature = signDesktopRequest(this.session.signingSecret, { method: "POST", path, timestamp, nonce, contentSha256 });
    return {
      Authorization: `Bearer ${this.session.accessToken}`,
      "X-Cliper-Timestamp": timestamp,
      "X-Cliper-Nonce": nonce,
      "X-Cliper-Content-SHA256": contentSha256,
      "X-Cliper-Signature": signature,
    };
  }

  private verifyResponse(path: string, response: CliperChatResponse): void {
    if (!this.session || !response.integrity) throw new Error("Response Cloud tidak memiliki integrity signature.");
    const integrity = response.integrity;
    const unsigned = { ...response, integrity: undefined };
    delete unsigned.integrity;
    const checksum = sha256Hex(JSON.stringify(unsigned));
    if (checksum !== integrity.checksum) throw new Error("Checksum response Cloud tidak cocok.");
    const valid = verifyDesktopRequestSignature(this.session.signingSecret, {
      method: "RESPONSE",
      path,
      timestamp: integrity.timestamp,
      nonce: "response",
      contentSha256: integrity.checksum,
    }, integrity.signature);
    if (!valid) throw new Error("Signature response Cloud tidak valid.");
  }
}
