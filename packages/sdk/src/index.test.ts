import { describe, expect, it } from "vitest";
import { resolveCloudEndpoint } from "./index.js";

describe("resolveCloudEndpoint", () => {
  it("routes auth calls to the API root when a gateway /v1 base URL is supplied", () => {
    expect(resolveCloudEndpoint("https://api.example.test/v1", "/api/auth/verify"))
      .toBe("https://api.example.test/api/auth/verify");
  });

  it("keeps gateway calls under /v1 without duplicating the segment", () => {
    expect(resolveCloudEndpoint("https://api.example.test/v1/", "/v1/chat/completions"))
      .toBe("https://api.example.test/v1/chat/completions");
  });

  it("preserves an intentional reverse-proxy path prefix", () => {
    expect(resolveCloudEndpoint("https://api.example.test/cliper/v1", "/api/auth/desktop/activate"))
      .toBe("https://api.example.test/cliper/api/auth/desktop/activate");
  });
});
