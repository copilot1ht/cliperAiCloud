import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service.js";
import type { Prisma } from "../generated/prisma/client.js";

const RELEASE_STATES = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const;
const RELEASE_CHANNELS = ["beta", "stable"] as const;

export type DesktopReleaseState = typeof RELEASE_STATES[number];
export type DesktopReleaseChannel = typeof RELEASE_CHANNELS[number];

export interface DesktopReleaseInput {
  version?: unknown;
  channel?: unknown;
  state?: unknown;
  notes?: unknown;
  setupUrl?: unknown;
  portableUrl?: unknown;
  checksumsUrl?: unknown;
  isCurrent?: unknown;
}

interface StoredRelease {
  id: string;
  version: string;
  channel: string;
  state: string;
  releaseNotes: string;
  setupUrl: string | null;
  portableUrl: string | null;
  checksumsUrl: string | null;
  isCurrent: boolean;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ReleaseDraft {
  version: string;
  channel: DesktopReleaseChannel;
  state: DesktopReleaseState;
  releaseNotes: string;
  setupUrl: string | null;
  portableUrl: string | null;
  checksumsUrl: string | null;
  isCurrent: boolean;
}

function normalizeVersion(value: unknown): string {
  const version = String(value || "").trim().replace(/^v/i, "");
  if (!/^\d+\.\d+\.\d+(?:-[a-z0-9][a-z0-9.-]*)?$/i.test(version)) {
    throw new BadRequestException("Versi harus memakai format seperti 1.11.0 atau 1.11.0-beta.1.");
  }
  if (version.length > 80) throw new BadRequestException("Versi release terlalu panjang.");
  return version;
}

function normalizeChannel(value: unknown): DesktopReleaseChannel {
  const channel = String(value || "beta").trim().toLowerCase();
  if (!RELEASE_CHANNELS.includes(channel as DesktopReleaseChannel)) {
    throw new BadRequestException("Channel release harus beta atau stable.");
  }
  return channel as DesktopReleaseChannel;
}

function normalizeState(value: unknown): DesktopReleaseState {
  const state = String(value || "DRAFT").trim().toUpperCase();
  if (!RELEASE_STATES.includes(state as DesktopReleaseState)) {
    throw new BadRequestException("Status release tidak valid.");
  }
  return state as DesktopReleaseState;
}

function normalizeNotes(value: unknown): string {
  const notes = String(value || "").replace(/\r\n/g, "\n").trim();
  if (notes.length > 4_000) throw new BadRequestException("Catatan release maksimal 4.000 karakter.");
  return notes;
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [first, second] = parts;
  if (first === undefined || second === undefined) return false;
  return first === 10
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || first === 0;
}

function normalizePublicUrl(value: unknown, label: string): string | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (raw.length > 2_048) throw new BadRequestException(`${label} terlalu panjang.`);

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new BadRequestException(`${label} harus berupa URL HTTPS yang valid.`);
  }
  const hostname = parsed.hostname.toLowerCase();
  const privateIpv6 = hostname === "::1" || hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe80:");
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || hostname === "localhost" || hostname.endsWith(".local") || isPrivateIpv4(hostname) || privateIpv6) {
    throw new BadRequestException(`${label} harus memakai host HTTPS publik, bukan localhost atau jaringan privat.`);
  }
  return parsed.toString();
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new BadRequestException("Nilai current release tidak valid.");
  return value;
}

function notesList(notes: string): string[] {
  return notes.split("\n").map((note) => note.replace(/^[\-*]\s*/, "").trim()).filter(Boolean);
}

@Injectable()
export class ReleaseCatalogService {
  constructor(private readonly database: DatabaseService) {}

  async listPublished() {
    const releases = await this.requireClient().desktopRelease.findMany({
      where: { state: "PUBLISHED" },
      orderBy: [{ isCurrent: "desc" }, { publishedAt: "desc" }, { createdAt: "desc" }],
    });
    return { releases: releases.map((release) => this.present(release)) };
  }

  async latestPublished(channel: unknown = "stable") {
    const release = await this.requireClient().desktopRelease.findFirst({
      where: {
        state: "PUBLISHED",
        channel: normalizeChannel(channel),
      },
      orderBy: [
        { isCurrent: "desc" },
        { publishedAt: "desc" },
        { createdAt: "desc" },
      ],
    });
    if (!release) throw new NotFoundException("Release publik tidak ditemukan.");
    return { release: this.present(release) };
  }

  async listAdmin() {
    const client = this.requireClient();
    const releases = await client.desktopRelease.findMany({
      orderBy: [{ isCurrent: "desc" }, { publishedAt: "desc" }, { createdAt: "desc" }],
    });
    return { releases: releases.map((release) => this.present(release)) };
  }

  async create(input: DesktopReleaseInput, actorId?: string) {
    const draft = this.normalizeInput(input);
    this.assertPublishable(draft);
    const client = this.requireClient();
    const created = await client.$transaction(async (tx) => {
      if (draft.isCurrent) {
        await tx.desktopRelease.updateMany({ where: { isCurrent: true }, data: { isCurrent: false } });
      }
      return tx.desktopRelease.create({
        data: {
          ...draft,
          publishedAt: draft.state === "PUBLISHED" ? new Date() : null,
        },
      });
    });
    await this.writeAudit("desktop_release.created", actorId, created.id, { version: created.version, state: created.state, current: created.isCurrent });
    return this.present(created);
  }

  async update(id: string, input: DesktopReleaseInput, actorId?: string) {
    const client = this.requireClient();
    const existing = await client.desktopRelease.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException("Release tidak ditemukan.");
    const draft = this.normalizeInput(input, existing);
    this.assertPublishable(draft);
    const updated = await client.$transaction(async (tx) => {
      if (draft.isCurrent) {
        await tx.desktopRelease.updateMany({ where: { isCurrent: true, id: { not: id } }, data: { isCurrent: false } });
      }
      return tx.desktopRelease.update({
        where: { id },
        data: {
          ...draft,
          publishedAt: draft.state === "PUBLISHED" ? existing.publishedAt || new Date() : existing.publishedAt,
        },
      });
    });
    await this.writeAudit("desktop_release.updated", actorId, id, { version: updated.version, state: updated.state, current: updated.isCurrent });
    return this.present(updated);
  }

  private requireClient() {
    if (!this.database.configured()) {
      throw new ServiceUnavailableException("PostgreSQL wajib aktif untuk mengelola release desktop.");
    }
    return this.database.client();
  }

  private normalizeInput(input: DesktopReleaseInput, existing?: StoredRelease): ReleaseDraft {
    const state = input.state === undefined && existing ? normalizeState(existing.state) : normalizeState(input.state);
    const draft: ReleaseDraft = {
      version: input.version === undefined && existing ? existing.version : normalizeVersion(input.version),
      channel: input.channel === undefined && existing ? normalizeChannel(existing.channel) : normalizeChannel(input.channel),
      state,
      releaseNotes: input.notes === undefined && existing ? existing.releaseNotes : normalizeNotes(input.notes),
      setupUrl: input.setupUrl === undefined && existing ? existing.setupUrl : normalizePublicUrl(input.setupUrl, "URL Setup"),
      portableUrl: input.portableUrl === undefined && existing ? existing.portableUrl : normalizePublicUrl(input.portableUrl, "URL Portable"),
      checksumsUrl: input.checksumsUrl === undefined && existing ? existing.checksumsUrl : normalizePublicUrl(input.checksumsUrl, "URL SHA-256"),
      isCurrent: booleanValue(input.isCurrent, existing?.isCurrent || false),
    };
    if (draft.state !== "PUBLISHED") draft.isCurrent = false;
    return draft;
  }

  private assertPublishable(draft: ReleaseDraft) {
    if (draft.state === "PUBLISHED" && !draft.setupUrl && !draft.portableUrl) {
      throw new BadRequestException("Tambahkan URL Setup atau Portable sebelum mempublikasikan release.");
    }
  }

  private present(release: StoredRelease) {
    return {
      id: release.id,
      version: release.version,
      channel: normalizeChannel(release.channel),
      state: normalizeState(release.state),
      notes: notesList(release.releaseNotes),
      setupUrl: release.setupUrl,
      portableUrl: release.portableUrl,
      checksumsUrl: release.checksumsUrl,
      isCurrent: release.isCurrent,
      publishedAt: release.publishedAt?.toISOString() || null,
      createdAt: release.createdAt.toISOString(),
      updatedAt: release.updatedAt.toISOString(),
    };
  }

  private async writeAudit(action: string, actorId: string | undefined, entityId: string, metadata: Record<string, Prisma.InputJsonValue>) {
    try {
      await this.requireClient().auditLog.create({ data: { actorId, action, entityType: "desktop_release", entityId, metadata } });
    } catch {
      // A release remains valid when a non-critical audit write is temporarily unavailable.
    }
  }
}
