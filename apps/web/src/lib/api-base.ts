export function apiBase(): string {
  const configured = String(process.env.NEXT_PUBLIC_API_URL || "").trim();
  if (configured) return configured.replace(/\/$/, "");
  return process.env.NODE_ENV === "production" ? "/cloud-api" : "http://localhost:4100";
}
