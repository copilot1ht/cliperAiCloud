export const CODEX_REGENERATION_PROMPT = `
You are regenerating a new project named "Cliper short Youtube Ai".

Reference goal:
- Rebuild the product behavior of the audited YT Short Clipper / CLIPER AI project.
- Keep the new implementation lightweight, maintainable, and easy to ship.
- Preserve all core workflows: YouTube URL input, cookies, subtitles, AI highlight finder, highlight selection, portrait clip rendering, captions, hook scene, watermark, session browser, settings, provider configuration, and upload integrations.

Recommended architecture:
- Use a JSX UI shell for the app workspace.
- Keep video processing in a Python worker or equivalent local service.
- Do not rewrite FFmpeg, yt-dlp, OpenCV, or MediaPipe behavior in frontend JavaScript.
- Use a bridge API between UI and worker for progress, cancellation, logs, and results.
- Make OpenAI-compatible providers the first supported API shape.
- Add Cliper hosted API mode later for credits, DOKU top-up, and provider routing.

Product name:
- Display name: Cliper short Youtube Ai
- Repository name: cliper-short-youtube-ai
- Executable name: CliperShortYoutubeAi

Must deliver:
1. A usable first screen, not a landing page.
2. A settings hub with AI providers per module.
3. A clear in-app guide.
4. Session-based output browser.
5. Robust error states for missing cookies, missing libraries, missing subtitles, invalid API key, and failed render.
6. A small, documented build process.

Implementation rule:
- Keep local mode working even when hosted billing is not configured.
- Add billing as optional mode, not a blocker for creators who bring their own API key.
`;

export default function CodexRegenerationPrompt() {
  return (
    <section data-blueprint="codex-regeneration-prompt">
      <h1>Codex Regeneration Prompt</h1>
      <pre>{CODEX_REGENERATION_PROMPT.trim()}</pre>
    </section>
  );
}
