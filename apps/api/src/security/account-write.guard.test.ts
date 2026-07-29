import { describe, expect, it } from "vitest";
import { AccountWriteGuard } from "./account-write.guard.js";

function context(role: "admin" | "investor" | "member") {
  const request = { cliperSession: { role } };
  return { switchToHttp: () => ({ getRequest: () => request }) } as never;
}

describe("AccountWriteGuard", () => {
  it("allows member and admin account actions", () => {
    const guard = new AccountWriteGuard();
    expect(guard.canActivate(context("member"))).toBe(true);
    expect(guard.canActivate(context("admin"))).toBe(true);
  });

  it("blocks investor key, billing, and account mutations", () => {
    expect(() => new AccountWriteGuard().canActivate(context("investor"))).toThrow("hanya memiliki akses baca");
  });
});
