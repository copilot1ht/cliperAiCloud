import { BadRequestException, Injectable } from "@nestjs/common";
import {
  chooseDefaultModel,
  getProviderPreset,
  isSupportedProvider,
  providerAcceptsModel,
  type SupportedProviderCode,
} from "./provider-catalog.js";

export interface ProviderConnectionInput {
  provider?: string;
  apiKey?: string;
}

export interface ProviderConnectionResult {
  provider: SupportedProviderCode;
  displayName: string;
  baseUrl: string;
  protocol: "openai-chat" | "anthropic-messages";
  models: string[];
  defaultModel: string;
  latencyMs: number;
  health: "healthy";
  checkedAt: string;
  modelSource: "api";
}

function modelsEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/models`;
}

function authHeaders(code: SupportedProviderCode, apiKey: string): Record<string, string> {
  if (code === "claude") {
    return { "x-api-key": apiKey, "anthropic-version": "2023-06-01", Accept: "application/json" };
  }
  return { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
}

function safeProviderMessage(payload: Record<string, unknown>, status: number): string {
  const error = payload.error;
  const message = typeof error === "object" && error
    ? String((error as Record<string, unknown>).message || "")
    : typeof error === "string" ? error : "";
  if (status === 401 || status === 403) return "API key tidak valid atau tidak memiliki akses.";
  if (status === 429) return "Provider menolak test karena rate limit atau kuota habis.";
  if (status >= 500) return "Layanan provider sedang bermasalah. Coba lagi beberapa saat.";
  return message.slice(0, 180) || `Provider mengembalikan HTTP ${status}.`;
}

function collectModels(code: SupportedProviderCode, payload: Record<string, unknown>): string[] {
  const values: string[] = [];
  const data = Array.isArray(payload.data) ? payload.data : [];
  for (const item of data) {
    if (item && typeof item === "object" && (item as Record<string, unknown>).id) {
      values.push(String((item as Record<string, unknown>).id));
    }
  }
  const models = Array.isArray(payload.models) ? payload.models : [];
  for (const item of models) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const methods = Array.isArray(record.supportedGenerationMethods) ? record.supportedGenerationMethods.map(String) : [];
    if (code === "gemini" && methods.length && !methods.includes("generateContent")) continue;
    const raw = String(record.baseModelId || record.name || "").replace(/^models\//, "");
    if (raw) values.push(raw);
  }
  return Array.from(new Set(values.map((item) => item.trim()).filter((item) => providerAcceptsModel(code, item))))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 100);
}

export async function testProviderConnection(
  input: ProviderConnectionInput,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderConnectionResult> {
  const provider = String(input.provider || "").trim().toLowerCase();
  const apiKey = String(input.apiKey || "").trim();
  if (!isSupportedProvider(provider)) throw new BadRequestException("Provider belum didukung oleh Simple Mode.");
  if (apiKey.length < 12) throw new BadRequestException("API key belum valid atau terlalu pendek.");

  const preset = getProviderPreset(provider);
  const errors: string[] = [];
  for (const baseUrl of preset.baseUrls) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(preset.timeoutMs, 20_000));
    try {
      const response = await fetchImpl(modelsEndpoint(baseUrl), {
        method: "GET",
        headers: authHeaders(provider, apiKey),
        signal: controller.signal,
      });
      const raw = await response.text();
      let payload: Record<string, unknown> = {};
      try {
        payload = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      } catch {
        throw new BadRequestException(`Respons ${preset.displayName} bukan JSON yang valid.`);
      }
      if (!response.ok) {
        errors.push(safeProviderMessage(payload, response.status));
        continue;
      }
      const models = collectModels(provider, payload);
      if (!models.length) {
        errors.push(`${preset.displayName} terhubung tetapi tidak mengembalikan model chat yang kompatibel.`);
        continue;
      }
      return {
        provider,
        displayName: preset.displayName,
        baseUrl,
        protocol: preset.protocol,
        models,
        defaultModel: chooseDefaultModel(preset, models),
        latencyMs: Date.now() - started,
        health: "healthy",
        checkedAt: new Date().toISOString(),
        modelSource: "api",
      };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      const message = error instanceof Error && error.name === "AbortError"
        ? "Test provider timeout. Periksa jaringan lalu coba lagi."
        : "Provider tidak dapat dihubungi. Periksa koneksi internet.";
      errors.push(message);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new BadRequestException(errors.at(-1) || "Provider tidak dapat diuji.");
}

@Injectable()
export class ProviderConnectionService {
  test(input: ProviderConnectionInput): Promise<ProviderConnectionResult> {
    return testProviderConnection(input);
  }
}
