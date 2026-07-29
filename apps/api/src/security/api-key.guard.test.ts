import { describe, expect, it } from "vitest";
import { LicenseService } from "../license/license.service.js";
import { ApiKeyGuard, bearerToken, type CliperAuthenticatedRequest } from "./api-key.guard.js";

describe("bearerToken", () => {
  it("extracts a bearer API key", () => expect(bearerToken("Bearer clp_test")).toBe("clp_test"));
  it("rejects other schemes", () => expect(bearerToken("Basic abc")).toBe(""));

  it("accepts a member-generated Cliper key and attaches its owner account", async () => {
    const licenses = new LicenseService();
    const generated = await licenses.createKey({ ownerId: "member-key-owner", plan: "pro" });
    const request = { headers: { authorization: `Bearer ${generated.rawKey}` } } as CliperAuthenticatedRequest;
    const context = { switchToHttp: () => ({ getRequest: () => request }) } as never;
    expect(await new ApiKeyGuard(licenses, {} as never).canActivate(context)).toBe(true);
    expect(request.cliperAuth).toMatchObject({ accountId: "member-key-owner", plan: "pro" });
  });
});
