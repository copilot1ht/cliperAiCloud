import { AppShell } from "@/components/app-shell";
import { desktopDownloadsReady, desktopReleases, releaseAssetUrl } from "@/lib/desktop-releases";
import { CheckCircle2, Download, FileArchive, History, ShieldCheck } from "lucide-react";

export default function DownloadsPage() {
  const current = desktopReleases.find((release) => release.status === "current") ?? desktopReleases[0];
  if (!current) return null;
  const setupUrl = releaseAssetUrl(current.version, "setup");
  const portableUrl = releaseAssetUrl(current.version, "portable");
  const checksumUrl = releaseAssetUrl(current.version, "checksums");

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
          {setupUrl
            ? <a className="button button-primary" href={setupUrl}><Download size={17} /> Download Setup</a>
            : <span className="button button-primary button-disabled" aria-disabled="true"><Download size={17} /> Segera tersedia</span>}
          {portableUrl
            ? <a className="button button-secondary" href={portableUrl}><FileArchive size={17} /> Portable</a>
            : <span className="button button-secondary button-disabled" aria-disabled="true"><FileArchive size={17} /> Portable belum tersedia</span>}
        </div>
      </section>
      {!desktopDownloadsReady && (
        <div className="notice notice-warning">
          Build beta sudah terdaftar, tetapi binary publik belum diterbitkan. Tombol download akan aktif setelah release asset lolos checksum dan tersedia di host publik.
        </div>
      )}

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
          {checksumUrl
            ? <a className="button button-secondary" href={checksumUrl}>Download SHA256SUMS</a>
            : <span className="button button-secondary button-disabled" aria-disabled="true">Checksum belum diterbitkan</span>}
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
