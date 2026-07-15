import ProjectManifest, { PROJECT_MANIFEST } from "./00_ProjectManifest.jsx";
import AuditReport, { AUDIT_REPORT } from "./01_AuditReport.jsx";
import SystemArchitecture, { SYSTEM_ARCHITECTURE } from "./02_SystemArchitecture.jsx";
import FeatureModules, { FEATURE_MODULES } from "./03_FeatureModules.jsx";
import UserFlows, { USER_FLOWS } from "./04_UserFlows.jsx";
import UIUXBlueprint, { UI_BLUEPRINT } from "./05_UIUXBlueprint.jsx";
import AIProviderBilling, { AI_PROVIDER_BILLING } from "./06_AIProviderBilling.jsx";
import ImplementationRoadmap, { IMPLEMENTATION_ROADMAP, ACCEPTANCE_TESTS } from "./07_ImplementationRoadmap.jsx";
import CodexRegenerationPrompt, { CODEX_REGENERATION_PROMPT } from "./08_CodexRegenerationPrompt.jsx";
import DataContracts, { DATA_CONTRACTS, WORKER_BRIDGE_CONTRACT } from "./09_DataContracts.jsx";
import ComponentScaffold, { COMPONENT_SCAFFOLD, SCREEN_ROUTES, STATE_SLICES } from "./10_ComponentScaffold.jsx";

export const CLIPER_SHORT_YOUTUBE_AI_BLUEPRINT = {
  manifest: PROJECT_MANIFEST,
  audit: AUDIT_REPORT,
  architecture: SYSTEM_ARCHITECTURE,
  features: FEATURE_MODULES,
  flows: USER_FLOWS,
  ui: UI_BLUEPRINT,
  billing: AI_PROVIDER_BILLING,
  roadmap: IMPLEMENTATION_ROADMAP,
  acceptanceTests: ACCEPTANCE_TESTS,
  codexPrompt: CODEX_REGENERATION_PROMPT,
  dataContracts: DATA_CONTRACTS,
  workerBridge: WORKER_BRIDGE_CONTRACT,
  componentScaffold: COMPONENT_SCAFFOLD,
  routes: SCREEN_ROUTES,
  stateSlices: STATE_SLICES
};

export default function CliperShortYoutubeAiBlueprint() {
  return (
    <main data-blueprint="cliper-short-youtube-ai">
      <ProjectManifest />
      <AuditReport />
      <SystemArchitecture />
      <FeatureModules />
      <UserFlows />
      <UIUXBlueprint />
      <AIProviderBilling />
      <ImplementationRoadmap />
      <CodexRegenerationPrompt />
      <DataContracts />
      <ComponentScaffold />
    </main>
  );
}
