import { describe, expect, it } from "vitest";
import { desktopDownloadsReady, desktopReleases, releaseAssetUrl } from "./desktop-releases";

describe("desktop release catalog", () => {
  it("keeps one current release and never invents a download host", () => {
    const current = desktopReleases.filter((release) => release.status === "current");

    expect(current).toHaveLength(1);
    expect(current[0]?.version).toBe("1.11.0-beta.1");
    expect(desktopDownloadsReady).toBe(false);
    expect(releaseAssetUrl(current[0]!.version, "setup")).toBeUndefined();
    expect(releaseAssetUrl(current[0]!.version, "portable")).toBeUndefined();
    expect(releaseAssetUrl(current[0]!.version, "checksums")).toBeUndefined();
  });
});
