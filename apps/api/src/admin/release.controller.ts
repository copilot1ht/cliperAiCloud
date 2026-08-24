import { Controller, Get, Inject, Query } from "@nestjs/common";
import { ReleaseCatalogService } from "./release-catalog.service.js";

// Release metadata and public binary URLs are intentionally public. The
// binaries themselves are hosted outside Railway/Vercel by the configured URL.
@Controller("api/releases")
export class ReleaseController {
  constructor(@Inject(ReleaseCatalogService) private readonly releases: ReleaseCatalogService) {}

  @Get()
  listPublished() {
    return this.releases.listPublished();
  }

  @Get("latest")
  latestPublished(@Query("channel") channel?: string) {
    return this.releases.latestPublished(channel || "stable");
  }
}
