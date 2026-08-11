-- Safe additive migration for admin-assisted password recovery. Existing
-- accounts remain on their current credential until an administrator starts a
-- reset for that individual account.
ALTER TABLE "users" ADD COLUMN "passwordResetRequiredAt" TIMESTAMP(3);

CREATE TABLE "password_reset_credentials" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_credentials_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "password_reset_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "password_reset_sessions_tokenHash_key" ON "password_reset_sessions"("tokenHash");
CREATE INDEX "password_reset_credentials_userId_expiresAt_idx" ON "password_reset_credentials"("userId", "expiresAt");
CREATE INDEX "password_reset_credentials_expiresAt_idx" ON "password_reset_credentials"("expiresAt");
CREATE INDEX "password_reset_credentials_usedAt_idx" ON "password_reset_credentials"("usedAt");
CREATE INDEX "password_reset_sessions_userId_expiresAt_idx" ON "password_reset_sessions"("userId", "expiresAt");
CREATE INDEX "password_reset_sessions_expiresAt_idx" ON "password_reset_sessions"("expiresAt");

ALTER TABLE "password_reset_credentials"
  ADD CONSTRAINT "password_reset_credentials_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "password_reset_credentials"
  ADD CONSTRAINT "password_reset_credentials_createdByAdminId_fkey"
  FOREIGN KEY ("createdByAdminId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "password_reset_sessions"
  ADD CONSTRAINT "password_reset_sessions_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
