import { AdminStoreService } from "../admin/admin-store.service.js";
import { DatabaseService } from "../database/database.service.js";
import { validateRuntimeConfig } from "./runtime-config.js";
import { loadWorkspaceEnv } from "./load-env.js";

loadWorkspaceEnv();

async function main(): Promise<void> {
  const report = validateRuntimeConfig();
  const database = new DatabaseService();
  let stored = 0;
  let healthy = 0;
  let databaseReachable = false;

  try {
    databaseReachable = await database.ping();
    if (databaseReachable) {
      // Provider keys managed in the admin UI intentionally live encrypted in
      // PostgreSQL. The CLI must consider them too, otherwise config:check
      // reports a false negative whenever .env does not contain provider keys.
      const store = new AdminStoreService(database);
      await store.onModuleInit();
      const providers = store.listProviders();
      stored = providers.length;
      healthy = providers.filter(
        (provider) => provider.enabled && provider.status === "healthy" && provider.pricingConfigured,
      ).length;
    }
  } finally {
    await database.onModuleDestroy();
  }

  const environmentProviders = report.providers.filter((provider) => provider.enabled).length;
  const providerReady = environmentProviders > 0 || healthy > 0;
  const warnings = providerReady
    ? report.warnings.filter((warning) => !warning.startsWith("Tidak ada provider AI aktif."))
    : report.warnings;
  const effective = {
    ...report,
    ready: report.errors.length === 0 && providerReady && databaseReachable,
    warnings,
    providerReadiness: {
      environment: environmentProviders,
      stored,
      healthy,
      ready: providerReady,
    },
    databaseReachable,
  };
  console.log(JSON.stringify(effective, null, 2));
  if (!effective.ready) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
