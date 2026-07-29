import { describe, expect, it } from "vitest";
import { adminMenu } from "./admin-menu";

describe("adminMenu", () => {
  it("uses real pages instead of overview hash anchors", () => {
    expect(adminMenu.map((item) => item.href)).toEqual([
      "/admin/overview",
      "/admin/users",
      "/admin/api-keys",
      "/admin/providers",
      "/admin/ai-router",
      "/admin/revenue",
      "/admin/payments",
      "/admin/system-health",
      "/admin/security",
      "/admin/releases",
    ]);
    expect(adminMenu.every((item) => !item.href.includes("#"))).toBe(true);
  });
});
