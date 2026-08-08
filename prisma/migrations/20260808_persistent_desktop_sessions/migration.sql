-- Persist desktop work sessions across API restarts. Raw access/refresh
-- credentials are never stored; only their SHA-256 hashes are retained.
CREATE TABLE "desktop_sessions" (
    "id" TEXT NOT NULL,
    "apiKeyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "plan" "PlanCode" NOT NULL,
    "unlimited" BOOLEAN NOT NULL DEFAULT false,
    "deviceFingerprint" TEXT NOT NULL,
    "accessHash" TEXT NOT NULL,
    "refreshHash" TEXT NOT NULL,
    "encryptedSigningSecret" TEXT NOT NULL,
    "accessExpiresAt" TIMESTAMP(3) NOT NULL,
    "refreshExpiresAt" TIMESTAMP(3) NOT NULL,
    "offlineGraceUntil" TIMESTAMP(3) NOT NULL,
    "lastHeartbeatAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "desktop_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "desktop_request_nonces" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "desktop_request_nonces_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "desktop_sessions_accessHash_key" ON "desktop_sessions"("accessHash");
CREATE UNIQUE INDEX "desktop_sessions_refreshHash_key" ON "desktop_sessions"("refreshHash");
CREATE INDEX "desktop_sessions_apiKeyId_revokedAt_idx" ON "desktop_sessions"("apiKeyId", "revokedAt");
CREATE INDEX "desktop_sessions_userId_revokedAt_idx" ON "desktop_sessions"("userId", "revokedAt");
CREATE INDEX "desktop_sessions_accessExpiresAt_idx" ON "desktop_sessions"("accessExpiresAt");
CREATE UNIQUE INDEX "desktop_request_nonces_sessionId_nonce_key" ON "desktop_request_nonces"("sessionId", "nonce");
CREATE INDEX "desktop_request_nonces_expiresAt_idx" ON "desktop_request_nonces"("expiresAt");

ALTER TABLE "desktop_sessions"
  ADD CONSTRAINT "desktop_sessions_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "desktop_sessions"
  ADD CONSTRAINT "desktop_sessions_apiKeyId_fkey"
  FOREIGN KEY ("apiKeyId") REFERENCES "api_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "desktop_request_nonces"
  ADD CONSTRAINT "desktop_request_nonces_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "desktop_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
