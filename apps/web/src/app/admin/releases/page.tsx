import { AppShell } from "@/components/app-shell";
import { desktopDownloadsReady, desktopReleases, releaseAssetUrl } from "@/lib/desktop-releases";
import { Download, ExternalLink, PackageCheck } from "lucide-react";

export default function AdminReleasesPage() {
  return (
    <AppShell eyebrow="Distribution" title="Desktop releases" role="admin">
      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="section-kicker">Release catalog</p>
            <h2>Cliper Studio builds</h2>
            <p>Web tidak menyimpan EXE. Source tetap privat dan binary diterbitkan melalui host download publik terpisah.</p>
          </div>
          <PackageCheck size={22} />
        </div>
        {!desktopDownloadsReady && (
          <div className="notice notice-warning">
            Download belum aktif. Buat repository binary publik atau bucket R2, unggah tiga release asset, lalu isi NEXT_PUBLIC_DESKTOP_RELEASE_BASE_URL.
          </div>
        )}
        <div className="release-list admin-release-list">
          {desktopReleases.map((release) => {
            const setupUrl = releaseAssetUrl(release.version, "setup");
            const portableUrl = releaseAssetUrl(release.version, "portable");
            return (
              <article key={release.version}>
              <div>
                <strong>v{release.version}</strong>
                <span>{release.releasedAt} · {release.channel} · {release.status}</span>
              </div>
              <div className="release-row-actions">
                {setupUrl
                  ? <a className="button button-secondary" href={setupUrl}><Download size={15} /> Setup</a>
                  : <span className="button button-secondary button-disabled" aria-disabled="true"><Download size={15} /> Belum upload</span>}
                {portableUrl
                  ? <a className="button button-secondary" href={portableUrl}><ExternalLink size={15} /> Portable</a>
                  : <span className="button button-secondary button-disabled" aria-disabled="true"><ExternalLink size={15} /> Belum upload</span>}
              </div>
            </article>
            );
          })}
        </div>
      </section>
    </AppShell>
  );
}
