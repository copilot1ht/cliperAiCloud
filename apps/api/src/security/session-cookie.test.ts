import { afterEach, describe, expect, it } from "vitest";
import {
  clearPasswordResetSessionCookie,
  clearSessionCookie,
  passwordResetSessionCookie,
  passwordResetSessionToken,
  sessionCookie,
  sessionToken,
} from "./session-cookie.js";

const previousNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  process.env.NODE_ENV = previousNodeEnv;
});

describe("session cookie", () => {
  it("prefers bearer for API clients and reads HttpOnly cookie fallback", () => {
    expect(sessionToken("Bearer cli-token", "cliper_session=browser-token")).toBe("cli-token");
    expect(sessionToken(undefined, "theme=dark; cliper_session=browser-token")).toBe("browser-token");
  });

  it("uses Secure in production and clears with the same safety attributes", () => {
    process.env.NODE_ENV = "production";
    const value = sessionCookie("secret", new Date(Date.now() + 60_000).toISOString());
    expect(value).toContain("HttpOnly");
    expect(value).toContain("SameSite=Lax");
    expect(value).toContain("Secure");
    expect(clearSessionCookie()).toContain("Max-Age=0");
  });

  it("uses a distinct HttpOnly cookie for the restricted reset session", () => {
    process.env.NODE_ENV = "production";
    const value = passwordResetSessionCookie("reset-secret", new Date(Date.now() + 60_000).toISOString());
    expect(value).toContain("cliper_password_reset=reset-secret");
    expect(value).toContain("HttpOnly");
    expect(value).toContain("Secure");
    expect(passwordResetSessionToken("theme=dark; cliper_password_reset=reset-secret")).toBe("reset-secret");
    expect(clearPasswordResetSessionCookie()).toContain("Max-Age=0");
  });
});
