export const IMPLEMENTATION_ROADMAP = [
  {
    phase: "Phase 0",
    title: "Prepare regeneration context",
    tasks: [
      "Read all files in the jsx folder.",
      "Keep the current project as behavioral reference.",
      "Choose desktop shell: React plus Tauri, or Python CustomTkinter.",
      "Keep Python worker for video processing in the first version."
    ],
    doneWhen: "New repository structure and dev commands are documented."
  },
  {
    phase: "Phase 1",
    title: "Local MVP parity",
    tasks: [
      "Build home screen and settings screen.",
      "Implement local config storage.",
      "Implement worker bridge methods for subtitles, highlight finding, processing, sessions, and cancellation.",
      "Port or reuse the existing AutoClipperCore behavior.",
      "Render output session browser."
    ],
    doneWhen: "A user can create at least one vertical clip from a YouTube URL using local config."
  },
  {
    phase: "Phase 2",
    title: "Quality and packaging",
    tasks: [
      "Add robust error pages and logs.",
      "Add dependency status and installer helpers.",
      "Add in-app guide.",
      "Add build scripts for Windows desktop.",
      "Smoke test start, settings, highlight search, cancellation, and completed output."
    ],
    doneWhen: "A release artifact can be generated and opened on Windows."
  },
  {
    phase: "Phase 3",
    title: "Hosted Cliper API mode",
    tasks: [
      "Add API key login or device auth.",
      "Add balance display.",
      "Add top-up flow against backend.",
      "Add OpenAI-compatible proxy calls through the backend.",
      "Add usage history."
    ],
    doneWhen: "A user can use paid credits without entering third-party provider keys."
  },
  {
    phase: "Phase 4",
    title: "Admin and provider routing",
    tasks: [
      "Build provider routing rules.",
      "Add DOKU callback reconciliation.",
      "Add provider health checks.",
      "Add margin and package management.",
      "Add fallback policy for JSON errors and audio endpoint failures."
    ],
    doneWhen: "Admin can operate pricing, providers, and manual credit adjustments."
  }
];

export const ACCEPTANCE_TESTS = [
  "Build succeeds from a clean checkout.",
  "No cloud login is required for local custom provider mode.",
  "The app explains missing cookies, missing subtitles, and missing FFmpeg clearly.",
  "Highlight detection does not render clips until user confirms selected highlights.",
  "All selected clips produce master.mp4 and data.json.",
  "Config survives app restart.",
  "Provider keys are not logged in plain text.",
  "DOKU payment callback is idempotent in hosted mode."
];

export default function ImplementationRoadmap() {
  return (
    <section data-blueprint="implementation-roadmap">
      <h1>Implementation Roadmap</h1>
      {IMPLEMENTATION_ROADMAP.map((phase) => (
        <article key={phase.phase}>
          <h2>{phase.phase}: {phase.title}</h2>
          <ul>
            {phase.tasks.map((task) => (
              <li key={task}>{task}</li>
            ))}
          </ul>
        </article>
      ))}
    </section>
  );
}
