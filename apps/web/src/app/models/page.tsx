import { AppShell } from "@/components/app-shell";
import { Layers, ShieldCheck, Sparkles } from "lucide-react";

const availableModels = [
  { name: "Gemini Flash", description: "Cepat dan akurat untuk pembuatan judul, highlight, dan metadata.", badge: "Recommended" },
  { name: "DeepSeek Chat", description: "Bagus untuk pembersihan caption dan pemrosesan bahasa alami yang konsisten.", badge: "Stable" },
  { name: "Custom AI", description: "Gunakan model custom bila kamu punya provider sendiri dan ingin kontrol penuh.", badge: "Advanced" },
];

export default function ModelsPage() {
  return (
    <AppShell eyebrow="Models" title="Model selection">
      <div className="notice-line"><div><ShieldCheck size={17} /><span><strong>Masukkan API key dan pilih model.</strong> Model terbaik dipilih otomatis berdasarkan routing dan plan kamu.</span></div></div>
      <section className="panel"><div className="panel-head"><div><p className="section-kicker">Recommended models</p><h2>Pilih model untuk workflow kamu</h2><p>Tiap model punya karakter berbeda; kamu bisa mulai dari rekomendasi lalu sesuaikan jika ingin kualitas atau biaya khusus.</p></div></div>
        <div className="plan-grid">
          {availableModels.map((model) => (
            <article className="plan-card" key={model.name}>
              <div className="plan-head"><span>{model.badge}</span></div>
              <h2>{model.name}</h2>
              <p>{model.description}</p>
              <button className="button button-secondary">Use this model</button>
            </article>
          ))}
        </div>
      </section>
      <section className="panel"><div className="panel-head"><div><p className="section-kicker">Panduan cepat</p><h2>Bagaimana memilih model</h2></div></div>
        <div className="readiness-list">
          <span><i className="ready" /><strong>Fast clips</strong><small>Pilih Gemini Flash untuk proses cepat dan latensi rendah.</small></span>
          <span><i className="ready" /><strong>Clean captions</strong><small>DeepSeek ideal untuk output teks dan transkripsi akurat.</small></span>
          <span><i className="ready" /><strong>Custom provider</strong><small>Gunakan custom AI saat ingin provider sendiri atau model khusus.</small></span>
        </div>
      </section>
    </AppShell>
  );
}
