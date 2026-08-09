-- Public desktop binaries stay on GitHub Releases, Cloudflare R2, or another
-- release host. This table stores only public release metadata and URLs.
CREATE TABLE IF NOT EXISTS "desktop_releases" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'beta',
    "state" TEXT NOT NULL DEFAULT 'DRAFT',
    "releaseNotes" TEXT NOT NULL DEFAULT '',
    "setupUrl" TEXT,
    "portableUrl" TEXT,
    "checksumsUrl" TEXT,
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "desktop_releases_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "desktop_releases_version_key" ON "desktop_releases"("version");
CREATE UNIQUE INDEX IF NOT EXISTS "desktop_releases_single_current_key" ON "desktop_releases"("isCurrent") WHERE "isCurrent" = true;
CREATE INDEX IF NOT EXISTS "desktop_releases_state_publishedAt_idx" ON "desktop_releases"("state", "publishedAt");
CREATE INDEX IF NOT EXISTS "desktop_releases_isCurrent_idx" ON "desktop_releases"("isCurrent");

-- Keep the previously advertised beta entries as drafts. Admin must add
-- public asset URLs before publishing them to members.
INSERT INTO "desktop_releases" (
  "id", "version", "channel", "state", "releaseNotes", "isCurrent", "createdAt", "updatedAt"
) VALUES
  (
    'desktop-release-1-11-0-beta-1',
    '1.11.0-beta.1',
    'beta',
    'DRAFT',
    'Content-aware highlight scoring, adaptive camera tracking, and strengthened subtitle/render validation.',
    false,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    'desktop-release-1-10-0-beta-3',
    '1.10.0-beta.3',
    'beta',
    'DRAFT',
    'Previous beta retained for manual rollback after its binary is published.',
    false,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  )
ON CONFLICT ("version") DO NOTHING;
