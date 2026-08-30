import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SafeReportText, isCanonicalGitHubRepositoryUrl } from "./safe-report-text";

describe("SafeReportText", () => {
  it("links only an exact canonical GitHub repository URL and preserves newlines", () => {
    const report = "Top choice\nhttps://github.com/open-telemetry/opentelemetry-js\nReady";
    const { container } = render(
      <div style={{ whiteSpace: "pre-wrap" }}>
        <SafeReportText text={report} />
      </div>,
    );

    const link = screen.getByRole("link", {
      name: "https://github.com/open-telemetry/opentelemetry-js",
    });
    expect(link).toHaveAttribute("href", "https://github.com/open-telemetry/opentelemetry-js");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(container.textContent).toBe(report);
  });

  it.each([
    "https://evil.com/acme/repo",
    "https://github.com.evil.com/acme/repo",
    "https://github.com/acme/repo/issues",
    "https://github.com/acme/repo?tab=readme",
    "https://github.com/acme/repo#readme",
    "https://github.com/acme/repo/",
    "[repo](https://github.com/acme/repo)",
  ])("keeps a non-canonical or formatted token as plain text: %s", (value) => {
    const { container } = render(<SafeReportText text={value} />);

    expect(container).toHaveTextContent(value);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("renders HTML and scripts as inert plain text", () => {
    const payload = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const { container } = render(<SafeReportText text={payload} />);

    expect(container).toHaveTextContent(payload);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.innerHTML).toContain("&lt;script&gt;");
  });
});

describe("isCanonicalGitHubRepositoryUrl", () => {
  it("uses the runtime owner and repository grammar", () => {
    expect(isCanonicalGitHubRepositoryUrl("https://github.com/a/repo._-1")).toBe(true);
    expect(isCanonicalGitHubRepositoryUrl("https://github.com/-owner/repo")).toBe(false);
    expect(isCanonicalGitHubRepositoryUrl("https://github.com/owner-/repo")).toBe(false);
    expect(isCanonicalGitHubRepositoryUrl("https://github.com/owner/..")).toBe(false);
  });
});
