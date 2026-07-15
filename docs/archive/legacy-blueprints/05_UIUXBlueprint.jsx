export const UI_BLUEPRINT = {
  designTone: "modern, light enough to scan, dark productive workspace, no marketing landing page",
  firstScreen: {
    title: "Cliper short Youtube Ai",
    layout: "single app workspace",
    panels: [
      "Top header with app name, Settings, Guide, API Status, Library Status",
      "Left input panel for URL, subtitle language, clip count, and cookies",
      "Right 16:9 preview panel",
      "Primary full-width Find Highlights button",
      "Session browser shortcut"
    ]
  },
  visualRules: [
    "Use 8px corner radius for cards and panels.",
    "Avoid nested cards.",
    "Use compact headings inside panels.",
    "Use icons only when they clarify action, not as decoration.",
    "Keep text labels short and user-facing.",
    "Do not hide required setup behind advanced menus.",
    "Make buttons stable in width and height.",
    "Avoid one-color monotone palettes and heavy decorative gradients."
  ],
  screens: [
    {
      id: "home",
      purpose: "Start a clipping job",
      emptyState: "Preview thumbnail akan tampil di sini",
      primaryAction: "Cari Highlight"
    },
    {
      id: "guide",
      purpose: "Explain setup and usage inside the app",
      sections: ["Setup Library", "Cookies YouTube", "AI API", "Find Highlights", "Render Clips", "Browse Output"]
    },
    {
      id: "ai_settings",
      purpose: "Configure task-scoped providers",
      cardTitles: ["Highlight Finder", "Caption Maker", "Hook Maker", "Title Generator"]
    },
    {
      id: "highlight_selection",
      purpose: "Let users choose clips before rendering",
      controls: ["Select All", "Deselect All", "Add Captions", "Add Hook Text", "Process Selected Clips"]
    },
    {
      id: "processing",
      purpose: "Show progress and allow cancellation",
      controls: ["Cancel", "Back", "Open Output", "Browse Sessions"]
    },
    {
      id: "sessions",
      purpose: "Browse previous work",
      itemContent: ["thumbnail", "title", "duration", "hook", "date", "upload status"]
    }
  ],
  responsiveRules: [
    "Desktop width above 900px uses two-column home layout.",
    "Tablet width stacks preview below form.",
    "Mobile wrapper uses one-column layout and bottom action bar.",
    "Long text wraps inside cards and never overlaps controls."
  ]
};

export default function UIUXBlueprint() {
  return (
    <section data-blueprint="ui-ux">
      <h1>UI and UX Blueprint</h1>
      <p>{UI_BLUEPRINT.designTone}</p>
      {UI_BLUEPRINT.screens.map((screen) => (
        <article key={screen.id}>
          <h2>{screen.id}</h2>
          <p>{screen.purpose}</p>
        </article>
      ))}
    </section>
  );
}
