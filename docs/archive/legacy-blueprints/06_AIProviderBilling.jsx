export const AI_PROVIDER_BILLING = {
  modules: {
    highlight_finder: {
      purpose: "Find viral moments from transcript",
      defaultModel: "gpt-4.1-mini",
      cheapRoutes: ["gemini-2.5-flash-lite", "llama-3.1-8b-instant"],
      safeRoutes: ["gpt-4.1-mini", "gpt-4.1"],
      outputContract: "Strict JSON list of highlights with title, timestamps, score, description, hook_text, and transcript_text"
    },
    caption_maker: {
      purpose: "Transcribe audio and create timed captions",
      defaultModel: "whisper-1",
      cheapRoutes: ["whisper-large-v3-turbo"],
      safeRoutes: ["whisper-1"],
      outputContract: "Segments and word timings when available"
    },
    hook_maker: {
      purpose: "Generate hook voice and hook overlay scene",
      defaultModel: "tts-1",
      cheapRoutes: ["OpenAI-compatible TTS endpoint"],
      safeRoutes: ["tts-1", "tts-1-hd"],
      outputContract: "Audio bytes or local audio file path"
    },
    youtube_title_maker: {
      purpose: "Generate title, description, tags, and upload metadata",
      defaultModel: "gpt-4.1-mini",
      cheapRoutes: ["gemini-2.5-flash-lite", "llama-3.1-8b-instant"],
      safeRoutes: ["gpt-4.1-mini"],
      outputContract: "Strict JSON title, description, tags"
    }
  },
  creditPackages: [
    { id: "starter", label: "Starter", priceIdr: 10000, audience: "trial users" },
    { id: "creator", label: "Creator", priceIdr: 25000, audience: "regular lightweight creators" },
    { id: "pro", label: "Pro", priceIdr: 50000, audience: "frequent creators" },
    { id: "studio", label: "Studio", priceIdr: 100000, audience: "small agencies" }
  ],
  dokuFlow: [
    "App or web portal creates top-up request",
    "Backend creates invoice and DOKU Checkout session",
    "User pays on DOKU hosted checkout",
    "DOKU sends callback to backend",
    "Backend validates signature and final status",
    "Backend writes idempotent credit ledger entry",
    "App refreshes balance"
  ],
  ledgerRules: [
    "Never mutate balance directly without a ledger entry.",
    "Every AI call stores estimated cost, charged credit, provider, latency, and status.",
    "Payment callback must be idempotent by invoice id and provider transaction id.",
    "Admin adjustment must store actor, reason, and before/after balance."
  ],
  backendEndpoints: [
    "POST /v1/auth/device",
    "GET /v1/balance",
    "POST /v1/topups",
    "GET /v1/topups/:id",
    "GET /v1/models",
    "POST /v1/chat/completions",
    "POST /v1/audio/transcriptions",
    "POST /v1/audio/speech",
    "GET /v1/usage"
  ]
};

export default function AIProviderBilling() {
  return (
    <section data-blueprint="ai-provider-billing">
      <h1>AI Provider and Billing</h1>
      {Object.entries(AI_PROVIDER_BILLING.modules).map(([id, module]) => (
        <article key={id}>
          <h2>{id}</h2>
          <p>{module.purpose}</p>
          <p>Default model: {module.defaultModel}</p>
        </article>
      ))}
    </section>
  );
}
