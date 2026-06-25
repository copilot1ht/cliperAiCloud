export const PROJECT_MANIFEST = {
  name: "Cliper short Youtube Ai",
  codename: "cliper-short-youtube-ai",
  sourceProject: "YT Short Clipper / CLIPER AI",
  versionTarget: "1.0.0",
  language: "id-ID",
  productType: "desktop-first video clipping tool with optional web and mobile wrapper",
  primaryUsers: [
    "YouTube creators",
    "Podcast editors",
    "Short-form content agencies",
    "UMKM, coaches, and educators who repurpose long videos"
  ],
  corePromise: "Paste a YouTube URL, let AI find strong moments, select highlights, and render vertical shorts with captions, hooks, watermark, and upload metadata.",
  implementationPriority: [
    "Keep core clipping logic local and deterministic",
    "Use a lightweight UI shell",
    "Use task-specific AI provider configuration",
    "Make setup simple for non-technical users",
    "Design for paid credits and provider routing from day one"
  ],
  preferredStack: {
    ui: "React JSX with Vite, or CustomTkinter if regenerating as Python desktop",
    desktopPackaging: "Tauri for a lightweight modern shell, or PyInstaller if keeping Python-only desktop",
    localWorker: "Python 3.10+ worker for yt-dlp, FFmpeg, OpenCV, MediaPipe optional, and OpenAI-compatible API calls",
    state: "Small local JSON config plus session metadata files",
    backend: "Optional hosted API gateway for credits, DOKU payment, provider routing, and admin dashboard"
  },
  namingRules: {
    displayName: "Cliper short Youtube Ai",
    executableName: "CliperShortYoutubeAi",
    configFolderName: "CliperShortYoutubeAi",
    repositoryName: "cliper-short-youtube-ai"
  },
  nonGoalsForFirstRegeneration: [
    "Do not build a heavy video editor timeline",
    "Do not require cloud upload for local rendering",
    "Do not make Android APK the first milestone unless a WebView/mobile wrapper is explicitly chosen",
    "Do not remove custom provider support"
  ],
  mustPreserve: [
    "YouTube URL input",
    "cookies.txt support",
    "subtitle discovery and fallback transcription",
    "highlight selection before rendering",
    "portrait conversion",
    "optional captions",
    "optional hook scene with TTS",
    "watermark and credit watermark settings",
    "output session browser",
    "YouTube upload and Repliz upload integrations",
    "AI provider separation per task"
  ]
};

export default function ProjectManifest() {
  return (
    <main data-blueprint="project-manifest">
      <h1>{PROJECT_MANIFEST.name}</h1>
      <p>{PROJECT_MANIFEST.corePromise}</p>
      <section>
        <h2>Target Stack</h2>
        <ul>
          {Object.entries(PROJECT_MANIFEST.preferredStack).map(([key, value]) => (
            <li key={key}>
              <strong>{key}</strong>: {value}
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2>Must Preserve</h2>
        <ul>
          {PROJECT_MANIFEST.mustPreserve.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>
    </main>
  );
}
