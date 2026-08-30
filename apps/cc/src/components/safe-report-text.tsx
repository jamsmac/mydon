import { Fragment } from "react";

const GITHUB_REPOSITORY_PREFIX = "https://github.com/";
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const GITHUB_REPOSITORY = /^[A-Za-z0-9._-]+$/;

/** Exact public repository URL reconstructed by the solution-scout runtime. */
export function isCanonicalGitHubRepositoryUrl(value: string): boolean {
  if (!value.startsWith(GITHUB_REPOSITORY_PREFIX)) return false;

  const path = value.slice(GITHUB_REPOSITORY_PREFIX.length);
  const parts = path.split("/");
  if (parts.length !== 2) return false;

  const owner = parts[0] ?? "";
  const repository = parts[1] ?? "";
  return (
    owner.length >= 1 &&
    owner.length <= 39 &&
    GITHUB_OWNER.test(owner) &&
    repository.length >= 1 &&
    repository.length <= 100 &&
    repository !== "." &&
    repository !== ".." &&
    GITHUB_REPOSITORY.test(repository)
  );
}

/**
 * Renders untrusted report text without parsing HTML or Markdown. Only a
 * whitespace-delimited, exact canonical GitHub repository URL becomes a link.
 */
export function SafeReportText({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\s+)/u).map((part, index) =>
        isCanonicalGitHubRepositoryUrl(part) ? (
          <a key={index} href={part} target="_blank" rel="noopener noreferrer">
            {part}
          </a>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </>
  );
}
