export const desktopReleaseBaseUrl =
  process.env.NEXT_PUBLIC_DESKTOP_RELEASE_BASE_URL?.trim().replace(/\/$/, "") || "";

export const desktopDownloadsReady = Boolean(desktopReleaseBaseUrl);

export interface DesktopRelease {
  version: string;
  channel: "beta" | "stable";
  releasedAt: string;
  status: "current" | "previous";
  notes: string[];
  setupSha256?: string;
  portableSha256?: string;
}

export const desktopReleases: DesktopRelease[] = [
  {
    version: "1.11.0-beta.1",
    channel: "beta",
    releasedAt: "2026-07-29",
    status: "current",
    notes: [
      "Content-aware highlight scoring untuk podcast, tutorial, review, vlog, gaming, news, dan music.",
      "Adaptive camera tracking dengan YuNet, body fallback, active-speaker evidence, dan safe framing.",
      "Subtitle word timing, render validation, dan Cliper AI Cloud localhost workflow diperketat.",
    ],
    setupSha256: "46d2d3cb770d4e62ba92b9961263159d2d1e660090f4711af5b7a27d0bf95f67",
    portableSha256: "be17281e0fea3b6282f2c17c82340b29261f25a6264751474c3b04db4c3f41c7",
  },
  {
    version: "1.10.0-beta.3",
    channel: "beta",
    releasedAt: "2026-07-20",
    status: "previous",
    notes: ["Beta sebelumnya untuk pembanding dan rollback manual."],
  },
];

export function releaseAssetUrl(version: string, asset: "setup" | "portable" | "checksums") {
  if (!desktopReleaseBaseUrl) return undefined;
  const tag = `v${version}`;
  const file = {
    setup: "Cliper-Studio-Plus-Setup.exe",
    portable: "Cliper-Studio-Plus-Portable.exe",
    checksums: "SHA256SUMS.txt",
  }[asset];
  return `${desktopReleaseBaseUrl}/${tag}/${file}`;
}
