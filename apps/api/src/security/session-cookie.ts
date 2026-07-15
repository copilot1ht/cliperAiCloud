import { bearerToken } from "./api-key.guard.js";

export const SESSION_COOKIE = "cliper_session";

export function sessionToken(authorization?: string, cookieHeader?: string): string {
  const bearer = bearerToken(authorization);
  if (bearer) return bearer;
  const cookies = String(cookieHeader || "").split(";");
  for (const item of cookies) {
    const [name, ...parts] = item.trim().split("=");
    if (name === SESSION_COOKIE) return decodeURIComponent(parts.join("="));
  }
  return "";
}

export function sessionCookie(value: string, expiresAt: string): string {
  const maxAge = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function clearSessionCookie(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}
