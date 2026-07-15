-- Provider Manager V2 keeps technical provider metadata on the server.
ALTER TABLE "providers"
  ADD COLUMN "protocol" TEXT NOT NULL DEFAULT 'openai-chat',
  ADD COLUMN "availableModels" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "modelSource" TEXT NOT NULL DEFAULT 'preset',
  ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "lastHealthMessage" TEXT,
  ADD COLUMN "lastModelSyncAt" TIMESTAMP(3);
