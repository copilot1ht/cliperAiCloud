import { AppShell } from "@/components/app-shell";
import { desktopReleases, releaseAssetUrl } from "@/lib/desktop-releases";
import { Download, ExternalLink, PackageCheck } from "lucide-react";

export default function AdminReleasesPage() {
  return (
    <AppShell eyebrow="Distribution" title="Desktop releases" role="admin">
      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="section-kicker">Release catalog</p>
            <h2>Cliper Studio builds</h2>
            <p>Daftar statis dari release GitHub. Web tidak menyimpan file EXE sehingga hosting tetap ringan.</p>
          </div>
          <PackageCheck size={22} />
        </div>
        <div className="release-list admin-release-list">
          {desktopReleases.map((release) => (
            <article key={release.version}>
              <div>
                <strong>v{release.version}</strong>
                <span>{release.releasedAt} · {release.channel} · {release.status}</span>
              </div>
              <div className="release-row-actions">
                <a className="button button-secondary" href={releaseAssetUrl(release.version, "setup")}><Download size={15} /> Setup</a>
                <a className="button button-secondary" href={releaseAssetUrl(release.version, "portable")}><ExternalLink size={15} /> Portable</a>
              </div>
            </article>
          ))}
        </div>
      </section>
    </AppShell>
  );
}
