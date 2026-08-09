import { AppShell } from "@/components/app-shell";
import { MemberReleaseCatalog } from "@/components/release-catalog";

export default function DownloadsPage() {
  return <AppShell eyebrow="Desktop app" title="Download Cliper Studio"><MemberReleaseCatalog /></AppShell>;
}
