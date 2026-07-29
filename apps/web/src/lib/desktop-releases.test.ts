import { describe, expect, it } from "vitest";
import { desktopReleases, releaseAssetUrl } from "./desktop-releases";

describe("desktop release catalog", () => {
  it("keeps one current release and exposes GitHub release assets", () => {
    const current = desktopReleases.filter((release) => release.status === "current");

    expect(current).toHaveLength(1);
    expect(current[0]?.version).toBe("1.11.0-beta.1");
    expect(releaseAssetUrl(current[0]!.version, "setup")).toContain(
      "/releases/download/v1.11.0-beta.1/Cliper-Studio-Plus-Setup.exe",
    );
    expect(releaseAssetUrl(current[0]!.version, "portable")).toContain(
      "/releases/download/v1.11.0-beta.1/Cliper-Studio-Plus-Portable.exe",
    );
    expect(releaseAssetUrl(current[0]!.version, "checksums")).toContain(
      "/releases/download/v1.11.0-beta.1/SHA256SUMS.txt",
    );
  });
});
