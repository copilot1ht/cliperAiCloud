export const USER_FLOWS = [
  {
    id: "first_run",
    title: "First Run Setup",
    steps: [
      "Open the app",
      "Accept terms when shown",
      "Open Library Status",
      "Install or verify FFmpeg, yt-dlp, and Deno",
      "Upload cookies.txt",
      "Open AI API settings",
      "Configure Highlight Finder, Caption Maker, Hook Maker, and Title Generator",
      "Validate and save each provider"
    ],
    failureStates: [
      "Missing FFmpeg blocks rendering",
      "Missing cookies can block restricted YouTube access",
      "Provider without transcription endpoint blocks captions",
      "Provider without TTS endpoint blocks hook voice"
    ]
  },
  {
    id: "create_clips",
    title: "Create Shorts From YouTube URL",
    steps: [
      "Paste YouTube URL",
      "Choose subtitle language",
      "Set clip count from 1 to 10",
      "Find highlights",
      "Review AI suggestions",
      "Select the best highlights",
      "Choose optional captions and hook scene",
      "Process selected clips",
      "Open session results"
    ],
    successState: "Each selected highlight becomes a vertical clip with data.json metadata."
  },
  {
    id: "subtitle_fallback",
    title: "Subtitle Missing Fallback",
    steps: [
      "User starts highlight detection",
      "Worker cannot find usable subtitle",
      "App explains the issue",
      "User confirms transcription fallback",
      "Worker downloads audio or video",
      "Caption maker transcribes audio",
      "Highlight finder uses generated transcript"
    ],
    successState: "User can continue even when YouTube subtitle is unavailable."
  },
  {
    id: "upload",
    title: "Publish or Upload Output",
    steps: [
      "Open Results or Browse Sessions",
      "Select clip",
      "Review generated title, description, and tags",
      "Upload to YouTube or Repliz when configured",
      "Save uploaded URL back into metadata"
    ],
    successState: "Uploaded clips show uploaded status and link."
  },
  {
    id: "paid_api_mode",
    title: "Paid Cliper API Mode",
    steps: [
      "User creates account or enters Cliper API key",
      "App checks balance",
      "User tops up through DOKU Checkout if needed",
      "Backend confirms payment and adds credits",
      "App uses Cliper API endpoint for AI calls",
      "Backend meters usage per module"
    ],
    successState: "User can use AI without managing separate provider keys."
  }
];

export default function UserFlows() {
  return (
    <section data-blueprint="user-flows">
      <h1>User Flows</h1>
      {USER_FLOWS.map((flow) => (
        <article key={flow.id}>
          <h2>{flow.title}</h2>
          <ol>
            {flow.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </article>
      ))}
    </section>
  );
}
