export const COMPONENT_SCAFFOLD = {
  appShell: [
    "AppShell",
    "TopNavigation",
    "StatusStrip",
    "PageContainer",
    "ConfirmDialog",
    "ErrorDialog"
  ],
  home: [
    "UrlInputPanel",
    "SubtitleSelector",
    "ClipCountInput",
    "CookiesCard",
    "VideoPreview",
    "FindHighlightsButton"
  ],
  settings: [
    "SettingsHub",
    "ProviderCard",
    "ProviderEditor",
    "ModelSelector",
    "OutputSettings",
    "PerformanceSettings",
    "WatermarkSettings",
    "HookStyleSettings",
    "ReplizSettings",
    "YouTubeApiSettings"
  ],
  highlights: [
    "HighlightSelectionPage",
    "HighlightCard",
    "ViralityBadge",
    "TranscriptPreview",
    "EnhancementToggles"
  ],
  processing: [
    "ProcessingPage",
    "ProgressSteps",
    "ClipProgressBar",
    "LogPreview",
    "CancelButton"
  ],
  sessions: [
    "SessionBrowser",
    "SessionCard",
    "ClipResultCard",
    "ThumbnailPreview",
    "UploadActions"
  ],
  billing: [
    "BalanceBadge",
    "TopupPackages",
    "DokuCheckoutButton",
    "UsageHistory",
    "PaymentStatus"
  ],
  guide: [
    "UsageGuidePage",
    "GuideStepCard",
    "SetupChecklist"
  ]
};

export const SCREEN_ROUTES = [
  { path: "/", name: "Home", component: "HomePage" },
  { path: "/guide", name: "Guide", component: "UsageGuidePage" },
  { path: "/settings", name: "Settings", component: "SettingsHub" },
  { path: "/settings/ai/:module", name: "AI Provider", component: "ProviderEditor" },
  { path: "/highlights/:sessionId", name: "Highlights", component: "HighlightSelectionPage" },
  { path: "/processing/:jobId", name: "Processing", component: "ProcessingPage" },
  { path: "/sessions", name: "Sessions", component: "SessionBrowser" },
  { path: "/billing", name: "Billing", component: "BillingPage" }
];

export const STATE_SLICES = [
  {
    id: "config",
    state: ["config", "providers", "isSaving", "lastSavedAt"],
    source: "local config bridge"
  },
  {
    id: "job",
    state: ["jobId", "status", "progress", "logs", "error", "resultSessionId"],
    source: "worker bridge progress events"
  },
  {
    id: "sessions",
    state: ["items", "selectedSession", "selectedClip"],
    source: "output folder scan"
  },
  {
    id: "billing",
    state: ["balance", "packages", "topupStatus", "usageItems"],
    source: "hosted API, optional"
  }
];

export default function ComponentScaffold() {
  return (
    <section data-blueprint="component-scaffold">
      <h1>Component Scaffold</h1>
      {Object.entries(COMPONENT_SCAFFOLD).map(([area, components]) => (
        <article key={area}>
          <h2>{area}</h2>
          <ul>
            {components.map((componentName) => (
              <li key={componentName}>{componentName}</li>
            ))}
          </ul>
        </article>
      ))}
    </section>
  );
}
