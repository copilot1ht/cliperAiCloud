import { Body, Controller, Inject, Post } from "@nestjs/common";
import type { LicenseValidationRequest } from "@cliper/contracts";
import { LicenseService } from "./license.service.js";

@Controller("v1/licenses")
export class LicenseController {
  constructor(@Inject(LicenseService) private readonly licenses: LicenseService) {}

  @Post("validate")
  async validate(@Body() request: LicenseValidationRequest) {
    return this.licenses.validate(request);
  }
}
