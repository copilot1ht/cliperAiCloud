export const DATA_CONTRACTS = {
  configJson: {
    api_key: "backward compatibility only",
    base_url: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    tts_model: "tts-1",
    temperature: 1.0,
    output_dir: "absolute path to output directory",
    installation_id: "uuid",
    ai_providers: {
      highlight_finder: { base_url: "", api_key: "", model: "gpt-4.1-mini" },
      caption_maker: { base_url: "", api_key: "", model: "whisper-1" },
      hook_maker: { base_url: "", api_key: "", model: "tts-1" },
      youtube_title_maker: { base_url: "", api_key: "", model: "gpt-4.1-mini" }
    },
    watermark: {
      enabled: false,
      image_path: "",
      position_x: 0.85,
      position_y: 0.05,
      opacity: 0.8,
      scale: 0.15
    },
    credit_watermark: {
      enabled: false,
      text: "",
      position: "bottom_right"
    },
    hook_style: {
      font_size: 72,
      text_color: "#FFFFFF",
      highlight_color: "#FFFF00",
      background_opacity: 0.45
    },
    face_tracking_mode: "opencv",
    gpu_acceleration: { enabled: false },
    repliz: { access_key: "", secret_key: "" }
  },
  sessionJson: {
    session_id: "YYYYMMDD-HHMMSS",
    url: "https://youtube.com/watch?v=...",
    created_at: "iso timestamp",
    status: "highlights_found | clipping | complete | failed",
    subtitle_language: "id",
    highlights: "array of Highlight",
    clips_dir: "output/session/clips"
  },
  highlight: {
    title: "string",
    description: "string",
    hook_text: "string",
    start_time: "00:00:00,000",
    end_time: "00:01:30,000",
    duration_seconds: 90,
    virality_score: 8,
    transcript_text: "string"
  },
  clipDataJson: {
    title: "string",
    hook_text: "string",
    start_time: "00:00:00,000",
    end_time: "00:01:30,000",
    duration_seconds: 90,
    has_hook: true,
    has_captions: true,
    youtube_title: "string",
    youtube_description: "string",
    youtube_tags: ["shorts", "viral"],
    youtube_url: ""
  }
};

export const WORKER_BRIDGE_CONTRACT = {
  methods: [
    {
      name: "getConfig",
      input: null,
      output: "configJson"
    },
    {
      name: "saveConfig",
      input: "partial configJson",
      output: "{ status: 'saved' }"
    },
    {
      name: "uploadCookies",
      input: "{ sourcePath: string }",
      output: "{ valid: boolean, message: string }"
    },
    {
      name: "fetchSubtitles",
      input: "{ url: string }",
      output: "{ languages: Array<{ code: string, label: string }> }"
    },
    {
      name: "findHighlights",
      input: "{ url: string, numClips: number, subtitleLanguage: string }",
      output: "{ session: sessionJson }"
    },
    {
      name: "processSelectedHighlights",
      input: "{ sessionId: string, selectedHighlights: Highlight[], addCaptions: boolean, addHook: boolean }",
      output: "{ jobId: string }"
    },
    {
      name: "getJobProgress",
      input: "{ jobId: string }",
      output: "{ status: string, progress: number, currentClip: number, totalClips: number, message: string }"
    },
    {
      name: "cancelJob",
      input: "{ jobId: string }",
      output: "{ cancelled: boolean }"
    },
    {
      name: "listSessions",
      input: null,
      output: "{ sessions: sessionJson[] }"
    },
    {
      name: "openOutputFolder",
      input: "{ path?: string }",
      output: "{ opened: boolean }"
    }
  ],
  events: [
    "job:started",
    "job:progress",
    "job:log",
    "job:error",
    "job:complete",
    "config:changed"
  ]
};

export default function DataContracts() {
  return (
    <section data-blueprint="data-contracts">
      <h1>Data Contracts</h1>
      <h2>Worker Bridge</h2>
      <ul>
        {WORKER_BRIDGE_CONTRACT.methods.map((method) => (
          <li key={method.name}>{method.name}</li>
        ))}
      </ul>
    </section>
  );
}
