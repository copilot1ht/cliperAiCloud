CREATE TABLE "payment_gateway_settings" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "isProduction" BOOLEAN NOT NULL DEFAULT false,
  "encryptedMerchantId" TEXT,
  "encryptedClientKey" TEXT,
  "encryptedServerKey" TEXT,
  "notificationUrl" TEXT,
  "finishRedirectUrl" TEXT,
  "updatedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "payment_gateway_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payment_gateway_settings_provider_key"
  ON "payment_gateway_settings"("provider");
