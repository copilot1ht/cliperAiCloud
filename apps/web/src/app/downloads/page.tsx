import { AppShell } from "@/components/app-shell";
import { desktopReleases, releaseAssetUrl } from "@/lib/desktop-releases";
import { CheckCircle2, Download, FileArchive, History, ShieldCheck } from "lucide-react";

export default function DownloadsPage() {
  const current = desktopReleases.find((release) => release.status === "current") ?? desktopReleases[0];
  if (!current) return null;

  return (
    <AppShell eyebrow="Desktop app" title="Download Cliper Studio">
      <section className="panel release-hero">
        <div>
          <p className="section-kicker">Windows release</p>
          <h2>Cliper Studio Plus {current.version}</h2>
          <p>Gunakan installer untuk pemakaian normal atau versi portable untuk pengujian di PC lain.</p>
          <div className="release-badges">
            <span>{current.channel}</span>
            <span>Windows 10/11</span>
            <span>64-bit</span>
          </div>
        </div>
        <div className="release-actions">
          <a className="button button-primary" href={releaseAssetUrl(current.version, "setup")}><Download size={17} /> Download Setup</a>
          <a className="button button-secondary" href={releaseAssetUrl(current.version, "portable")}><FileArchive size={17} /> Portable</a>
        </div>
      </section>

      <div className="release-grid">
        <section className="panel">
          <div className="panel-head"><div><p className="section-kicker">What changed</p><h2>Release notes</h2></div></div>
          <ul className="release-notes">
            {current.notes.map((note) => <li key={note}><CheckCircle2 size={17} /><span>{note}</span></li>)}
          </ul>
        </section>
        <section className="panel">
          <div className="panel-head"><div><p className="section-kicker">Integrity</p><h2>Verify download</h2></div><ShieldCheck size={20} /></div>
          <p className="release-copy">Cocokkan SHA-256 setelah download. File checksum diterbitkan bersama setiap release.</p>
          <a className="button button-secondary" href={releaseAssetUrl(current.version, "checksums")}>Download SHA256SUMS</a>
        </section>
      </div>

      <section className="panel">
        <div className="panel-head"><div><p className="section-kicker">Version history</p><h2>Daftar versi</h2></div><History size={20} /></div>
        <div className="release-list">
          {desktopReleases.map((release) => (
            <article key={release.version}>
              <div><strong>v{release.version}</strong><span>{release.releasedAt} · {release.channel}</span></div>
              <span className={`status-pill ${release.status === "current" ? "release-current" : ""}`}>{release.status === "current" ? "Latest" : "Previous"}</span>
            </article>
          ))}
        </div>
      </section>
    </AppShell>
  );
}
