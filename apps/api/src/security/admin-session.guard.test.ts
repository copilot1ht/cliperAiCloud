import { describe, expect, it } from "vitest";
import { AdminSessionGuard } from "./admin-session.guard.js";

function context(method: string) {
  const request = { method, headers: { authorization: "Bearer session" } };
  return {
    request,
    execution: { switchToHttp: () => ({ getRequest: () => request }) } as never,
  };
}

describe("AdminSessionGuard investor policy", () => {
  it("allows an investor to read admin monitoring endpoints", async () => {
    const auth = { session: async () => ({ userId: "investor", email: "investor@test.local", displayName: "Investor", role: "investor", expiresAt: Date.now() + 1000 }) };
    const guard = new AdminSessionGuard(auth as never);
    const request = context("GET");
    await expect(guard.canActivate(request.execution)).resolves.toBe(true);
    expect((request.request as { cliperAdminSession?: { role: string } }).cliperAdminSession?.role).toBe("investor");
  });

  it("blocks every investor mutation before the controller runs", async () => {
    const auth = { session: async () => ({ userId: "investor", email: "investor@test.local", displayName: "Investor", role: "investor", expiresAt: Date.now() + 1000 }) };
    const guard = new AdminSessionGuard(auth as never);
    await expect(guard.canActivate(context("PATCH").execution)).rejects.toThrow("hanya memiliki akses baca");
  });
});
