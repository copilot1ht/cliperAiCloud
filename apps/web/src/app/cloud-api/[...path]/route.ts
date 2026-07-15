import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ path: string[] }> };

const hopByHopHeaders = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function upstreamBase(): string {
  const value = String(process.env.CLIPER_API_URL || "").trim().replace(/\/$/, "");
  if (value) return value;
  if (process.env.NODE_ENV !== "production") return "http://localhost:4100";
  throw new Error("CLIPER_API_URL belum dikonfigurasi pada Vercel.");
}

async function proxy(request: NextRequest, context: RouteContext): Promise<Response> {
  try {
    const { path } = await context.params;
    const target = new URL(`${upstreamBase()}/${path.map(encodeURIComponent).join("/")}`);
    target.search = request.nextUrl.search;

    const headers = new Headers(request.headers);
    for (const name of hopByHopHeaders) headers.delete(name);
    headers.set("x-forwarded-host", request.nextUrl.host);
    headers.set("x-forwarded-proto", request.nextUrl.protocol.replace(":", ""));

    const hasBody = !["GET", "HEAD"].includes(request.method.toUpperCase());
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
      cache: "no-store",
      redirect: "manual",
    });

    const responseHeaders = new Headers();
    upstream.headers.forEach((value, name) => {
      if (!hopByHopHeaders.has(name.toLowerCase()) && !name.toLowerCase().startsWith("access-control-")) {
        responseHeaders.append(name, value);
      }
    });
    responseHeaders.set("cache-control", "no-store");
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cloud API tidak dapat dihubungi.";
    return Response.json({ statusCode: 503, message }, { status: 503 });
  }
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
