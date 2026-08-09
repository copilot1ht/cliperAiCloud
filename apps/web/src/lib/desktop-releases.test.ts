import { describe, expect, it } from "vitest";
import { releaseHasDownload, releaseStateLabel } from "./desktop-releases";

describe("desktop release catalog helpers", () => {
  it("only reports a release ready when a real binary URL exists", () => {
    expect(releaseHasDownload({ setupUrl: null, portableUrl: null })).toBe(false);
    expect(releaseHasDownload({ setupUrl: "https://downloads.example.com/setup.exe", portableUrl: null })).toBe(true);
    expect(releaseHasDownload({ setupUrl: null, portableUrl: "https://downloads.example.com/portable.exe" })).toBe(true);
  });

  it("uses stable human-readable state labels", () => {
    expect(releaseStateLabel("DRAFT")).toBe("Draft");
    expect(releaseStateLabel("PUBLISHED")).toBe("Published");
    expect(releaseStateLabel("ARCHIVED")).toBe("Archived");
  });
});
