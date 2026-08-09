export const desktopReleaseStates = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const;
export const desktopReleaseChannels = ["beta", "stable"] as const;

export type DesktopReleaseState = typeof desktopReleaseStates[number];
export type DesktopReleaseChannel = typeof desktopReleaseChannels[number];

export interface DesktopRelease {
  id: string;
  version: string;
  channel: DesktopReleaseChannel;
  state: DesktopReleaseState;
  notes: string[];
  setupUrl: string | null;
  portableUrl: string | null;
  checksumsUrl: string | null;
  isCurrent: boolean;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DesktopReleaseCatalog {
  releases: DesktopRelease[];
}

export function releaseHasDownload(release: Pick<DesktopRelease, "setupUrl" | "portableUrl">): boolean {
  return Boolean(release.setupUrl || release.portableUrl);
}

export function releaseStateLabel(state: DesktopReleaseState): string {
  return {
    DRAFT: "Draft",
    PUBLISHED: "Published",
    ARCHIVED: "Archived",
  }[state];
}
