export const AUDIT_REPORT = {
  auditedAt: "2026-06-24",
  auditedSource: "c:/Users/USER/Desktop/CLIPER AI/yt-short-clipper",
  currentBranchObserved: "codex/cliper-ai-ui-docs",
  sourceShape: {
    entrypoints: ["app.py", "webview_app.py"],
    coreEngine: "clipper_core.py",
    uiPages: "pages/",
    settingsPages: "pages/settings/",
    reusableComponents: "components/",
    config: ["config/config_manager.py", "config/ai_provider_config.py"],
    uploaders: ["youtube_uploader.py", "tiktok_uploader.py", "dialogs/repliz_upload.py"],
    buildTargets: ["build.spec", "build_macos.spec", "build_web.spec"]
  },
  strengths: [
    "Core workflow is already separated from most UI pages through AutoClipperCore.",
    "The app already supports task-specific AI providers: highlight finder, caption maker, hook maker, and title generator.",
    "Session-based output makes regeneration easier because clips and metadata are folder-based.",
    "The new highlight-selection flow avoids rendering every AI suggestion automatically.",
    "Dependency manager, GPU detector, and status pages are useful operational features to preserve.",
    "Build scripts already exist for Windows, macOS, and experimental webview."
  ],
  risks: [
    "The current UI is Python CustomTkinter, not JSX-native. A React regeneration should call a Python worker or API instead of rewriting video logic in JavaScript.",
    "MediaPipe is optional and can create packaging/version friction, so OpenCV should stay the default mode.",
    "YouTube access depends on yt-dlp behavior and cookies, so error handling and user guidance must stay prominent.",
    "Gemini and other non OpenAI-compatible APIs need adapters before direct desktop use.",
    "DOKU fees and settlement details must be confirmed in the merchant agreement before locking margins.",
    "Android APK is not produced by the current repository; a mobile wrapper is a separate milestone."
  ],
  recommendedRegenerationStrategy: [
    "Keep Python core as a local worker for the first version.",
    "Build a modern lightweight JSX UI around the existing workflow.",
    "Use one local bridge layer for long-running jobs, cancellation, and progress events.",
    "Keep all AI provider configuration task-scoped.",
    "Add hosted credit and payment features as an optional API gateway, not as a blocker for local mode."
  ],
  minimumParityChecklist: [
    "Can paste a YouTube URL and validate it.",
    "Can upload cookies.txt and show status.",
    "Can select subtitle language or use transcription fallback.",
    "Can find highlights without rendering clips first.",
    "Can select highlights and choose captions or hook scene.",
    "Can render vertical clips and browse sessions.",
    "Can configure AI providers per module.",
    "Can open output folder and inspect metadata."
  ]
};

export default function AuditReport() {
  return (
    <article data-blueprint="audit-report">
      <h1>Audit Report</h1>
      <p>Audited source: {AUDIT_REPORT.auditedSource}</p>
      <section>
        <h2>Strengths</h2>
        <ul>
          {AUDIT_REPORT.strengths.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>
      <section>
        <h2>Risks</h2>
        <ul>
          {AUDIT_REPORT.risks.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>
    </article>
  );
}
