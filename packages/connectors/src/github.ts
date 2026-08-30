/**
 * Read-only GitHub connector for solution-scout.
 *
 * The connector intentionally exposes only two fixed API operations. Callers
 * cannot supply a base URL or an arbitrary path, and response URLs are never
 * trusted: public repository links are reconstructed from validated full_name.
 */

const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_WEB_ORIGIN = "https://github.com";
const GITHUB_API_VERSION = "2026-03-10";

export const GITHUB_CONNECTOR_LIMITS = {
  maxQueryChars: 256,
  maxQueryBytes: 1_024,
  defaultItems: 10,
  maxItems: 25,
  minTimeoutMs: 100,
  defaultTimeoutMs: 10_000,
  maxTimeoutMs: 30_000,
  defaultResponseBytes: 1_500_000,
  maxResponseBytes: 2_000_000,
  defaultReadmeBytes: 512_000,
  maxReadmeBytes: 1_000_000,
} as const;

export type GitHubConnectorErrorCode =
  | "invalid_input"
  | "network_error"
  | "http_error"
  | "rate_limited"
  | "response_too_large"
  | "invalid_response";

export interface GitHubRateLimitEvidence {
  limit?: number;
  remaining?: number;
  used?: number;
  resetAt?: string;
  resource?: string;
  retryAfterMs?: number;
}

export class GitHubConnectorError extends Error {
  readonly name = "GitHubConnectorError";

  constructor(
    readonly code: GitHubConnectorErrorCode,
    message: string,
    readonly status: number | undefined = undefined,
    readonly rateLimit: GitHubRateLimitEvidence = {},
  ) {
    super(message);
  }
}

export interface GitHubConnectorConfig {
  /** Optional fine-grained or classic token. It is sent only to api.github.com. */
  token?: string;
  timeoutMs?: number;
  /** Maximum bytes read from any GitHub API response body. */
  maxResponseBytes?: number;
  /** Maximum decoded README bytes returned to solution-scout. */
  maxReadmeBytes?: number;
  fetchImpl?: typeof fetch;
}

export interface GitHubRepositoryEvidence {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  /** Canonical public URL reconstructed from validated fullName. */
  url: string;
  description: string | null;
  stars: number;
  forks: number;
  archived: boolean;
  language: string | null;
  topics: string[];
  licenseSpdx: string | null;
  defaultBranch: string;
  pushedAt: string | null;
  updatedAt: string;
}

export interface GitHubSearchResult {
  totalCount: number;
  incomplete: boolean;
  items: GitHubRepositoryEvidence[];
  rateLimit: GitHubRateLimitEvidence;
}

export interface GitHubSearchOptions {
  items?: number;
}

export interface GitHubReadmeEvidence {
  owner: string;
  repository: string;
  fullName: string;
  /** Canonical public repository URL; API-provided URLs are ignored. */
  url: string;
  name: string;
  path: string;
  sha: string;
  bytes: number;
  text: string;
  rateLimit: GitHubRateLimitEvidence;
}

export const GITHUB_MANIFEST_NAMES = [
  "package.json",
  "requirements.txt",
  "pyproject.toml",
] as const;

export type GitHubManifestName = (typeof GITHUB_MANIFEST_NAMES)[number];

export interface GitHubManifestEvidence {
  owner: string;
  repository: string;
  fullName: string;
  /** Canonical public repository URL; API-provided URLs are ignored. */
  url: string;
  manifest: GitHubManifestName;
  sha: string;
  bytes: number;
  text: string;
  rateLimit: GitHubRateLimitEvidence;
}

export type GitHubManifestResult =
  | { found: true; evidence: GitHubManifestEvidence }
  | {
      found: false;
      owner: string;
      repository: string;
      fullName: string;
      url: string;
      manifest: GitHubManifestName;
      rateLimit: GitHubRateLimitEvidence;
    };

interface JsonResponse {
  value: unknown;
  rateLimit: GitHubRateLimitEvidence;
}

interface ParsedFullName {
  owner: string;
  repository: string;
  fullName: string;
}

/** Fixed-origin, GET-only GitHub API client. It never retries implicitly. */
export class GitHubConnector {
  private readonly token: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxReadmeBytes: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: GitHubConnectorConfig = {}) {
    this.token = normalizeToken(config.token);
    this.timeoutMs = boundedInteger(
      config.timeoutMs,
      "timeoutMs",
      GITHUB_CONNECTOR_LIMITS.defaultTimeoutMs,
      GITHUB_CONNECTOR_LIMITS.minTimeoutMs,
      GITHUB_CONNECTOR_LIMITS.maxTimeoutMs,
    );
    this.maxResponseBytes = boundedInteger(
      config.maxResponseBytes,
      "maxResponseBytes",
      GITHUB_CONNECTOR_LIMITS.defaultResponseBytes,
      1,
      GITHUB_CONNECTOR_LIMITS.maxResponseBytes,
    );
    this.maxReadmeBytes = boundedInteger(
      config.maxReadmeBytes,
      "maxReadmeBytes",
      GITHUB_CONNECTOR_LIMITS.defaultReadmeBytes,
      1,
      GITHUB_CONNECTOR_LIMITS.maxReadmeBytes,
    );
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async searchRepositories(
    query: string,
    options: GitHubSearchOptions = {},
  ): Promise<GitHubSearchResult> {
    const normalizedQuery = validateQuery(query);
    const items = boundedInteger(
      options.items,
      "items",
      GITHUB_CONNECTOR_LIMITS.defaultItems,
      1,
      GITHUB_CONNECTOR_LIMITS.maxItems,
    );
    const url = fixedApiUrl("/search/repositories");
    url.searchParams.set("q", normalizedQuery);
    url.searchParams.set("per_page", String(items));
    url.searchParams.set("page", "1");

    const response = await this.getJson(url);
    try {
      const raw = record(response.value, "search response");
      const rawItems = array(raw.items, "search response.items");
      if (rawItems.length > items || rawItems.length > GITHUB_CONNECTOR_LIMITS.maxItems) {
        throw invalidResponse("GitHub search returned more items than requested");
      }
      return {
        totalCount: nonNegativeInteger(raw.total_count, "search response.total_count"),
        incomplete: boolean(raw.incomplete_results, "search response.incomplete_results"),
        items: rawItems.map((item) => parseRepository(item)),
        rateLimit: response.rateLimit,
      };
    } catch (error) {
      throw attachResponseEvidence(error, response.rateLimit);
    }
  }

  async getReadme(owner: string, repository: string): Promise<GitHubReadmeEvidence> {
    const normalizedOwner = validateOwner(owner, "owner");
    const normalizedRepository = validateRepositoryName(repository, "repository");
    const url = fixedApiUrl(
      `/repos/${encodeURIComponent(normalizedOwner)}/${encodeURIComponent(normalizedRepository)}/readme`,
    );
    const response = await this.getJson(url);
    try {
      const file = parseTextFile(response.value, "README", this.maxReadmeBytes, response.rateLimit);
      const fullName = `${normalizedOwner}/${normalizedRepository}`;
      return {
        owner: normalizedOwner,
        repository: normalizedRepository,
        fullName,
        url: `${GITHUB_WEB_ORIGIN}/${fullName}`,
        name: file.name,
        path: file.path,
        sha: file.sha,
        bytes: file.bytes,
        text: file.text,
        rateLimit: response.rateLimit,
      };
    } catch (error) {
      throw attachResponseEvidence(error, response.rateLimit);
    }
  }

  /** Fetches one top-level dependency manifest from a fixed allowlist. */
  async fetchManifest(
    owner: string,
    repository: string,
    manifest: GitHubManifestName,
  ): Promise<GitHubManifestResult> {
    const normalizedOwner = validateOwner(owner, "owner");
    const normalizedRepository = validateRepositoryName(repository, "repository");
    if (!isManifestName(manifest)) {
      throw new GitHubConnectorError(
        "invalid_input",
        "manifest must be an allowlisted top-level dependency file",
      );
    }
    const fullName = `${normalizedOwner}/${normalizedRepository}`;
    const repositoryUrl = `${GITHUB_WEB_ORIGIN}/${fullName}`;
    const url = fixedApiUrl(
      `/repos/${encodeURIComponent(normalizedOwner)}/${encodeURIComponent(normalizedRepository)}/contents/${manifest}`,
    );

    let response: JsonResponse;
    try {
      response = await this.getJson(url);
    } catch (error) {
      if (error instanceof GitHubConnectorError && error.status === 404) {
        return {
          found: false,
          owner: normalizedOwner,
          repository: normalizedRepository,
          fullName,
          url: repositoryUrl,
          manifest,
          rateLimit: error.rateLimit,
        };
      }
      throw error;
    }

    try {
      const file = parseTextFile(
        response.value,
        `manifest ${manifest}`,
        this.maxReadmeBytes,
        response.rateLimit,
      );
      if (file.name !== manifest || file.path !== manifest) {
        throw invalidResponse(
          "GitHub manifest response does not match the requested top-level file",
        );
      }
      return {
        found: true,
        evidence: {
          owner: normalizedOwner,
          repository: normalizedRepository,
          fullName,
          url: repositoryUrl,
          manifest,
          sha: file.sha,
          bytes: file.bytes,
          text: file.text,
          rateLimit: response.rateLimit,
        },
      };
    } catch (error) {
      throw attachResponseEvidence(error, response.rateLimit);
    }
  }

  private async getJson(url: URL): Promise<JsonResponse> {
    // Defense in depth: even internal URL construction must never escape the
    // one allowlisted API origin or switch to a mutating endpoint.
    if (url.origin !== GITHUB_API_ORIGIN) {
      throw new GitHubConnectorError("invalid_input", "GitHub API origin is not allowed");
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
          "User-Agent": "MYDON-Solution-Scout/1.0",
          ...(this.token === undefined ? {} : { Authorization: `Bearer ${this.token}` }),
        },
      });
    } catch {
      // A custom transport can echo request headers in its error. Never retain
      // it as cause or include its text in the public error.
      throw new GitHubConnectorError("network_error", "GitHub API request failed");
    }

    const rateLimit = rateLimitEvidence(response.headers);
    if (!response.ok) {
      await discardBody(response);
      const rateLimited =
        response.status === 429 ||
        (response.status === 403 &&
          (rateLimit.remaining === 0 || rateLimit.retryAfterMs !== undefined));
      throw new GitHubConnectorError(
        rateLimited ? "rate_limited" : "http_error",
        rateLimited
          ? `GitHub API rate limit reached (HTTP ${response.status})`
          : `GitHub API request failed (HTTP ${response.status})`,
        response.status,
        rateLimit,
      );
    }

    if (!isGitHubJsonContentType(response.headers.get("content-type"))) {
      await discardBody(response);
      throw invalidResponse(
        "GitHub API response has an unsupported Content-Type",
        response.status,
        rateLimit,
      );
    }

    const bytes = await readBoundedBody(
      response,
      this.maxResponseBytes,
      response.status,
      rateLimit,
    );
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw invalidResponse("GitHub API response is not valid UTF-8", response.status, rateLimit);
    }
    try {
      return { value: JSON.parse(text) as unknown, rateLimit };
    } catch {
      throw invalidResponse("GitHub API response is not valid JSON", response.status, rateLimit);
    }
  }
}

function fixedApiUrl(path: string): URL {
  return new URL(path, `${GITHUB_API_ORIGIN}/`);
}

function isGitHubJsonContentType(value: string | null): boolean {
  if (value === null) return false;
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || mediaType === "application/vnd.github+json";
}

function normalizeToken(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  if (hasControlCharacters(value)) {
    throw new GitHubConnectorError("invalid_input", "GitHub token contains invalid characters");
  }
  return value.trim();
}

function boundedInteger(
  value: number | undefined,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new GitHubConnectorError(
      "invalid_input",
      `${name} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return value;
}

function validateQuery(value: string): string {
  if (typeof value !== "string") {
    throw new GitHubConnectorError("invalid_input", "GitHub search query must be a string");
  }
  const normalized = value.trim();
  const chars = Array.from(normalized).length;
  const bytes = Buffer.byteLength(normalized, "utf8");
  if (
    chars === 0 ||
    chars > GITHUB_CONNECTOR_LIMITS.maxQueryChars ||
    bytes > GITHUB_CONNECTOR_LIMITS.maxQueryBytes ||
    hasControlCharacters(normalized)
  ) {
    throw new GitHubConnectorError(
      "invalid_input",
      `GitHub search query must contain 1-${GITHUB_CONNECTOR_LIMITS.maxQueryChars} safe characters`,
    );
  }
  return normalized;
}

function validateOwner(value: string, field: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (
    normalized.length === 0 ||
    normalized.length > 39 ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(normalized)
  ) {
    throw new GitHubConnectorError("invalid_input", `${field} is not a valid GitHub owner`);
  }
  return normalized;
}

function validateRepositoryName(value: string, field: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (
    normalized.length === 0 ||
    normalized.length > 100 ||
    normalized === "." ||
    normalized === ".." ||
    !/^[A-Za-z0-9._-]+$/.test(normalized)
  ) {
    throw new GitHubConnectorError("invalid_input", `${field} is not a valid GitHub repository`);
  }
  return normalized;
}

function parseFullName(value: unknown): ParsedFullName {
  if (typeof value !== "string") {
    throw invalidResponse("GitHub repository full_name is missing");
  }
  const parts = value.split("/");
  if (parts.length !== 2) {
    throw invalidResponse("GitHub repository full_name is invalid");
  }
  let owner: string;
  let repository: string;
  try {
    owner = validateOwner(parts[0] ?? "", "full_name owner");
    repository = validateRepositoryName(parts[1] ?? "", "full_name repository");
  } catch {
    throw invalidResponse("GitHub repository full_name is invalid");
  }
  if (`${owner}/${repository}` !== value) {
    throw invalidResponse("GitHub repository full_name is not canonical");
  }
  return { owner, repository, fullName: value };
}

function parseRepository(value: unknown): GitHubRepositoryEvidence {
  const raw = record(value, "search repository");
  const fullName = parseFullName(raw.full_name);
  const name = string(raw.name, "search repository.name", 100);
  if (name !== fullName.repository) {
    throw invalidResponse("GitHub repository name does not match full_name");
  }
  const description = nullableString(raw.description, "search repository.description", 2_000);
  const language = nullableString(raw.language, "search repository.language", 128);
  const topics = array(raw.topics, "search repository.topics");
  if (topics.length > 20) throw invalidResponse("GitHub repository has too many topics");
  const license = raw.license === null ? null : record(raw.license, "search repository.license");
  const licenseSpdx =
    license === null
      ? null
      : nullableString(license.spdx_id, "search repository.license.spdx_id", 128);

  return {
    id: positiveInteger(raw.id, "search repository.id"),
    owner: fullName.owner,
    name,
    fullName: fullName.fullName,
    url: `${GITHUB_WEB_ORIGIN}/${fullName.fullName}`,
    description,
    stars: nonNegativeInteger(raw.stargazers_count, "search repository.stargazers_count"),
    forks: nonNegativeInteger(raw.forks_count, "search repository.forks_count"),
    archived: boolean(raw.archived, "search repository.archived"),
    language,
    topics: topics.map((topic) => safeTopic(topic)),
    licenseSpdx,
    defaultBranch: string(raw.default_branch, "search repository.default_branch", 255),
    pushedAt: nullableIsoDate(raw.pushed_at, "search repository.pushed_at"),
    updatedAt: isoDate(raw.updated_at, "search repository.updated_at"),
  };
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidResponse(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw invalidResponse(`${field} must be an array`);
  return value;
}

function string(value: unknown, field: string, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    hasControlCharacters(value)
  ) {
    throw invalidResponse(`${field} must be a bounded safe string`);
  }
  return value;
}

function nullableString(value: unknown, field: string, maxLength: number): string | null {
  return value === null ? null : string(value, field, maxLength);
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 31 || code === 127)) return true;
  }
  return false;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw invalidResponse(`${field} must be boolean`);
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalidResponse(`${field} must be a non-negative integer`);
  }
  return value as number;
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = nonNegativeInteger(value, field);
  if (parsed === 0) throw invalidResponse(`${field} must be positive`);
  return parsed;
}

function isoDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw invalidResponse(`${field} must be an ISO timestamp`);
  }
  return new Date(value).toISOString();
}

function nullableIsoDate(value: unknown, field: string): string | null {
  return value === null ? null : isoDate(value, field);
}

function safeTopic(value: unknown): string {
  return string(value, "search repository topic", 50);
}

function safePathPart(value: unknown, field: string, maxLength: number): string {
  const parsed = string(value, field, maxLength);
  if (parsed === "." || parsed === ".." || parsed.includes("/") || parsed.includes("\\")) {
    throw invalidResponse(`${field} is not a safe path part`);
  }
  return parsed;
}

function safeRelativePath(value: unknown, field: string): string {
  const parsed = string(value, field, 4_096);
  if (
    parsed.startsWith("/") ||
    parsed.includes("\\") ||
    parsed.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw invalidResponse(`${field} is not a safe relative path`);
  }
  return parsed;
}

function gitObjectId(value: unknown): string {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
    throw invalidResponse("README response.sha is invalid");
  }
  return value;
}

function isManifestName(value: string): value is GitHubManifestName {
  return (GITHUB_MANIFEST_NAMES as readonly string[]).includes(value);
}

function parseTextFile(
  value: unknown,
  label: string,
  maximumBytes: number,
  rateLimit: GitHubRateLimitEvidence,
): { name: string; path: string; sha: string; bytes: number; text: string } {
  const raw = record(value, `${label} response`);
  if (raw.type !== "file" || raw.encoding !== "base64") {
    throw invalidResponse(`GitHub ${label} response is not a base64 file`);
  }
  const size = nonNegativeInteger(raw.size, `${label} response.size`);
  if (size > maximumBytes) throw responseTooLarge(rateLimit);
  const content = base64String(raw.content, `${label} response.content`);
  const decoded = decodeBase64(content, maximumBytes, rateLimit);
  if (decoded.byteLength !== size) {
    throw invalidResponse(`GitHub ${label} size does not match decoded content`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  } catch {
    throw invalidResponse(`GitHub ${label} is not valid UTF-8`);
  }
  return {
    name: safePathPart(raw.name, `${label} response.name`, 255),
    path: safeRelativePath(raw.path, `${label} response.path`),
    sha: gitObjectId(raw.sha),
    bytes: decoded.byteLength,
    text,
  };
}

function base64String(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length > GITHUB_CONNECTOR_LIMITS.maxResponseBytes) {
    throw invalidResponse(`${field} must be a bounded string`);
  }
  return value;
}

function decodeBase64(
  value: string,
  maximumBytes: number,
  rateLimit: GitHubRateLimitEvidence,
): Uint8Array {
  const compact = value.replace(/[\r\n]/g, "");
  if (/[^A-Za-z0-9+/=]/.test(compact) || !validBase64Shape(compact)) {
    throw invalidResponse("GitHub README content is not valid base64");
  }
  const maximumEncodedLength = Math.ceil(maximumBytes / 3) * 4;
  if (compact.length > maximumEncodedLength) throw responseTooLarge(rateLimit);
  const decoded = Buffer.from(compact, "base64");
  if (decoded.byteLength > maximumBytes) throw responseTooLarge(rateLimit);
  return decoded;
}

function validBase64Shape(value: string): boolean {
  if (value === "") return true;
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
  status: number,
  rateLimit: GitHubRateLimitEvidence,
): Promise<Uint8Array> {
  const contentLength = headerInteger(response.headers.get("content-length"));
  if (contentLength !== undefined && contentLength > maximumBytes) {
    await discardBody(response);
    throw responseTooLarge(rateLimit, status);
  }
  if (response.body === null) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      let result: Awaited<ReturnType<typeof reader.read>>;
      try {
        result = await reader.read();
      } catch {
        throw invalidResponse("GitHub API response body could not be read", status, rateLimit);
      }
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximumBytes) {
        try {
          await reader.cancel();
        } catch {
          // The safe outcome is still rejection; cancellation errors are not exposed.
        }
        throw responseTooLarge(rateLimit, status);
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Error bodies are untrusted and intentionally ignored.
  }
}

function rateLimitEvidence(headers: Headers): GitHubRateLimitEvidence {
  const limit = headerInteger(headers.get("x-ratelimit-limit"));
  const remaining = headerInteger(headers.get("x-ratelimit-remaining"));
  const used = headerInteger(headers.get("x-ratelimit-used"));
  const resetSeconds = headerInteger(headers.get("x-ratelimit-reset"));
  const resetAt =
    resetSeconds !== undefined && resetSeconds <= 8_640_000_000
      ? new Date(resetSeconds * 1_000).toISOString()
      : undefined;
  const resourceValue = headers.get("x-ratelimit-resource");
  const resource =
    resourceValue !== null && /^[A-Za-z0-9_-]{1,64}$/.test(resourceValue)
      ? resourceValue
      : undefined;
  const retryAfterMs = parseRetryAfter(headers.get("retry-after"));
  return {
    ...(limit !== undefined ? { limit } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...(used !== undefined ? { used } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
    ...(resource !== undefined ? { resource } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

function headerInteger(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) && seconds <= Number.MAX_SAFE_INTEGER / 1_000
      ? seconds * 1_000
      : undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}

function invalidResponse(
  message: string,
  status: number | undefined = undefined,
  rateLimit: GitHubRateLimitEvidence = {},
): GitHubConnectorError {
  return new GitHubConnectorError("invalid_response", message, status, rateLimit);
}

function responseTooLarge(
  rateLimit: GitHubRateLimitEvidence,
  status: number | undefined = undefined,
): GitHubConnectorError {
  return new GitHubConnectorError(
    "response_too_large",
    "GitHub API response exceeds the configured byte limit",
    status,
    rateLimit,
  );
}

function attachResponseEvidence(
  error: unknown,
  rateLimit: GitHubRateLimitEvidence,
): GitHubConnectorError {
  if (
    error instanceof GitHubConnectorError &&
    (error.code === "invalid_response" || error.code === "response_too_large")
  ) {
    return new GitHubConnectorError(error.code, error.message, error.status ?? 200, {
      ...rateLimit,
      ...error.rateLimit,
    });
  }
  throw error;
}

/** Convenience function for one bounded repository search. */
export async function searchGitHubRepositories(
  query: string,
  config: GitHubConnectorConfig = {},
  options: GitHubSearchOptions = {},
): Promise<GitHubSearchResult> {
  return new GitHubConnector(config).searchRepositories(query, options);
}

/** Convenience function for one bounded README fetch. */
export async function fetchGitHubReadme(
  owner: string,
  repository: string,
  config: GitHubConnectorConfig = {},
): Promise<GitHubReadmeEvidence> {
  return new GitHubConnector(config).getReadme(owner, repository);
}

/** Convenience function for one allowlisted dependency-manifest fetch. */
export async function fetchGitHubManifest(
  owner: string,
  repository: string,
  manifest: GitHubManifestName,
  config: GitHubConnectorConfig = {},
): Promise<GitHubManifestResult> {
  return new GitHubConnector(config).fetchManifest(owner, repository, manifest);
}
