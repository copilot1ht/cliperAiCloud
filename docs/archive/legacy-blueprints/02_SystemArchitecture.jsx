export const SYSTEM_ARCHITECTURE = {
  mode: "local-first with optional hosted credit API",
  layers: [
    {
      name: "JSX UI Shell",
      responsibility: [
        "Render home, setup, highlight selection, processing, sessions, settings, and guide views",
        "Show long-running job progress",
        "Validate inputs before calling the worker",
        "Keep the interface light, responsive, and readable"
      ]
    },
    {
      name: "Local App Bridge",
      responsibility: [
        "Expose worker actions to the UI",
        "Stream job progress and logs",
        "Handle cancellation",
        "Open folders and local files safely"
      ]
    },
    {
      name: "Python Worker",
      responsibility: [
        "Download subtitles and video sections with yt-dlp",
        "Cut and convert video with FFmpeg",
        "Detect faces with OpenCV by default",
        "Optionally use MediaPipe for active speaker tracking",
        "Generate captions, hook scenes, and metadata through AI providers"
      ]
    },
    {
      name: "Local Storage",
      responsibility: [
        "Store config.json",
        "Store cookies.txt",
        "Store output session folders",
        "Store data.json metadata per clip"
      ]
    },
    {
      name: "Hosted API Gateway",
      responsibility: [
        "Authenticate app users and API keys",
        "Check credit balance",
        "Create DOKU top-up invoices",
        "Route AI calls to cheaper providers",
        "Meter cost and maintain credit ledger"
      ]
    }
  ],
  dataFlow: [
    "User enters YouTube URL",
    "UI asks worker to fetch subtitles and video metadata",
    "Worker sends transcript to highlight_finder provider",
    "UI displays highlight candidates with score, time range, hook, and transcript preview",
    "User selects highlights and enhancement options",
    "Worker downloads only selected sections or uses existing local video",
    "Worker creates portrait clips, captions, hooks, watermark, and metadata",
    "UI shows session results and upload actions"
  ],
  folderStructureTarget: [
    "src/app",
    "src/components",
    "src/features/home",
    "src/features/settings",
    "src/features/highlights",
    "src/features/processing",
    "src/features/sessions",
    "src/features/billing",
    "src/bridge",
    "src/lib",
    "worker",
    "docs",
    "assets"
  ],
  outputSessionShape: {
    folder: "output/YYYYMMDD-HHMMSS/",
    files: [
      "session.json",
      "clips/clip_001/master.mp4",
      "clips/clip_001/data.json",
      "clips/clip_001/thumbnail.jpg"
    ]
  }
};

export default function SystemArchitecture() {
  return (
    <section data-blueprint="system-architecture">
      <h1>System Architecture</h1>
      <p>{SYSTEM_ARCHITECTURE.mode}</p>
      {SYSTEM_ARCHITECTURE.layers.map((layer) => (
        <article key={layer.name}>
          <h2>{layer.name}</h2>
          <ul>
            {layer.responsibility.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </article>
      ))}
    </section>
  );
}
