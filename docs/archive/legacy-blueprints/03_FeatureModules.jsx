export const FEATURE_MODULES = [
  {
    id: "home",
    name: "Home Processing Setup",
    required: true,
    fields: ["youtubeUrl", "subtitleLanguage", "clipCount", "cookiesStatus"],
    actions: ["pasteUrl", "uploadCookies", "fetchSubtitles", "findHighlights", "openSessions"],
    acceptance: [
      "Start button stays disabled until URL and cookies requirements are clear.",
      "Subtitle selector is disabled while loading and shows available languages after fetch.",
      "User can continue with transcription fallback when subtitles are missing."
    ]
  },
  {
    id: "ai_settings",
    name: "AI API Settings",
    required: true,
    modules: ["highlight_finder", "caption_maker", "hook_maker", "youtube_title_maker"],
    providerModes: ["Cliper API", "OpenAI", "Custom OpenAI-compatible endpoint"],
    acceptance: [
      "Each AI module can use a different base URL, API key, and model.",
      "Provider validation checks models when the endpoint supports it.",
      "Caption maker and hook maker warn if the provider may not support audio endpoints."
    ]
  },
  {
    id: "highlight_selection",
    name: "Highlight Selection",
    required: true,
    fields: ["title", "description", "hookText", "startTime", "endTime", "duration", "viralityScore", "transcriptPreview"],
    actions: ["selectAll", "deselectAll", "toggleCaptions", "toggleHook", "processSelected"],
    acceptance: [
      "Highlights are selectable before rendering.",
      "No clip is processed unless at least one highlight is selected.",
      "The page confirms selected count and enhancement options before starting."
    ]
  },
  {
    id: "processing",
    name: "Processing and Clipping",
    required: true,
    steps: ["Download subtitles", "Find highlights", "Download selected sections", "Convert portrait", "Add hook", "Add captions", "Write metadata"],
    actions: ["cancel", "openOutput", "browseSessions"],
    acceptance: [
      "Progress updates are visible per stage and per clip.",
      "Cancel sets a cancellation flag and disables duplicate cancel requests.",
      "Errors include a user-readable message and a path to logs when available."
    ]
  },
  {
    id: "sessions",
    name: "Session Browser and Results",
    required: true,
    actions: ["browseSessions", "resumeSession", "playClip", "openFolder", "uploadYouTube", "uploadRepliz"],
    acceptance: [
      "Sessions are sorted newest first.",
      "Completed clips show thumbnail, title, duration, and status.",
      "Old sessions remain compatible when video files still exist."
    ]
  },
  {
    id: "settings",
    name: "Settings Hub",
    required: true,
    subpages: ["AI API", "Performance", "Output", "Watermark", "Credit Watermark", "Hook Style", "Repliz", "YouTube API", "Guide", "About"],
    acceptance: [
      "Settings are grouped by user task, not by implementation detail.",
      "Save actions only update the intended config keys.",
      "The guide is available from both header and settings."
    ]
  },
  {
    id: "billing",
    name: "Credits and DOKU Top Up",
    required: false,
    actions: ["viewBalance", "createTopup", "openDokuCheckout", "refreshPaymentStatus", "viewUsage"],
    acceptance: [
      "Local mode can run without login.",
      "Cliper API mode requires API key or account session.",
      "Top-up status is only marked paid after backend confirmation."
    ]
  }
];

export default function FeatureModules() {
  return (
    <section data-blueprint="feature-modules">
      <h1>Feature Modules</h1>
      {FEATURE_MODULES.map((feature) => (
        <article key={feature.id} data-required={feature.required}>
          <h2>{feature.name}</h2>
          <ul>
            {feature.acceptance.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </article>
      ))}
    </section>
  );
}
