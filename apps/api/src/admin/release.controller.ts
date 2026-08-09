import { Controller, Get, Inject } from "@nestjs/common";
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
}
