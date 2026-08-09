import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { ReleaseCatalogService } from "./release-catalog.service.js";

function releaseRecord(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-08-09T12:00:00.000Z");
  return {
    id: "release-1",
    version: "1.11.0-beta.2",
    channel: "beta",
    state: "PUBLISHED",
    releaseNotes: "Subtitle sync\nNatural camera cuts",
    setupUrl: "https://downloads.example.com/Cliper-Setup.exe",
    portableUrl: null,
    checksumsUrl: "https://downloads.example.com/SHA256SUMS.txt",
    isCurrent: true,
    publishedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createService() {
  const releases = [releaseRecord()];
  const desktopRelease = {
    findMany: vi.fn().mockImplementation(async ({ where }: { where?: { state?: string } } = {}) => where?.state ? releases.filter((release) => release.state === where.state) : releases),
    findUnique: vi.fn().mockImplementation(async ({ where }: { where: { id: string } }) => releases.find((release) => release.id === where.id) || null),
    updateMany: vi.fn().mockImplementation(async ({ where, data }: { where: { isCurrent?: boolean; id?: { not: string } }; data: { isCurrent?: boolean } }) => {
      for (const release of releases) {
        if (where.isCurrent && !release.isCurrent) continue;
        if (where.id?.not && release.id === where.id.not) continue;
        Object.assign(release, data);
      }
      return { count: releases.length };
    }),
    create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      const created = releaseRecord({ id: `release-${releases.length + 1}`, ...data });
      releases.push(created);
      return created;
    }),
    update: vi.fn().mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const target = releases.find((release) => release.id === where.id)!;
      Object.assign(target, data, { updatedAt: new Date("2026-08-09T12:01:00.000Z") });
      return target;
    }),
  };
  const client: Record<string, any> = {
    desktopRelease,
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
    $transaction: async (callback: (transaction: Record<string, any>) => Promise<unknown>) => callback(client),
  };
  const database = { configured: () => true, client: () => client };
  return { service: new ReleaseCatalogService(database as never), desktopRelease, releases };
}

describe("ReleaseCatalogService", () => {
  it("only exposes published releases to members", async () => {
    const { service, releases } = createService();
    releases.push(releaseRecord({ id: "draft-1", version: "1.12.0-beta.1", state: "DRAFT", isCurrent: false }));

    const result = await service.listPublished();

    expect(result.releases).toHaveLength(1);
    expect(result.releases[0]).toMatchObject({ version: "1.11.0-beta.2", notes: ["Subtitle sync", "Natural camera cuts"] });
  });

  it("requires a public binary URL before a release can be published", async () => {
    const { service } = createService();

    await expect(service.create({ version: "1.12.0-beta.1", channel: "beta", state: "PUBLISHED" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create({ version: "1.12.0-beta.1", setupUrl: "http://127.0.0.1/setup.exe" })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("clears the previous current release when an admin publishes a new current build", async () => {
    const { service, desktopRelease, releases } = createService();

    const created = await service.create({
      version: "1.12.0-beta.1",
      channel: "beta",
      state: "PUBLISHED",
      setupUrl: "https://downloads.example.com/Cliper-1.12.0-Setup.exe",
      isCurrent: true,
    }, "admin-1");

    expect(created).toMatchObject({ version: "1.12.0-beta.1", isCurrent: true, state: "PUBLISHED" });
    expect(desktopRelease.updateMany).toHaveBeenCalledWith({ where: { isCurrent: true }, data: { isCurrent: false } });
    expect(releases.filter((release) => release.isCurrent)).toHaveLength(1);
  });
});
