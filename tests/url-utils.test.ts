import { describe, expect, it } from "vitest";
import { extractUrlsFromText, normalizeUrlCandidate } from "../src/utils/url";

describe("url normalization", () => {
  it("normalizes markdown-wrapped URL", () => {
    expect(normalizeUrlCandidate("`http://localhost:8080`.")).toBe("http://localhost:8080/");
    expect(normalizeUrlCandidate("(http://localhost:8080)`")).toBe("http://localhost:8080/");
  });

  it("extracts clean URLs from noisy text", () => {
    const urls = extractUrlsFromText("Open this: `http://localhost:8080`.) and then https://example.com/path.");
    expect(urls).toEqual(["http://localhost:8080/", "https://example.com/path"]);
  });
});
