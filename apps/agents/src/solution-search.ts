import {
  GITHUB_MANIFEST_NAMES,
  GitHubConnectorError,
  type GitHubManifestName,
  type GitHubManifestResult,
  type GitHubReadmeEvidence,
  type GitHubRepositoryEvidence,
  type GitHubSearchOptions,
  type GitHubSearchResult,
} from "@mydon/connectors";
import type { Domain } from "@mydon/shared";
import { callModel, type CallModelResult } from "./llm";
import { resolveModelChain, type ModelGateway } from "./model-gateway";
import type { Proposal } from "./skills";
import type { TaskLlmSession } from "./task-llm-session";

export const SOLUTION_SEARCH_SNAPSHOT_KIND = "solution-search-v1" as const;
export const SOLUTION_SEARCH_SNAPSHOT_MAX_BYTES = 64 * 1024;
export const SOLUTION_SEARCH_MAX_CANDIDATES = 3;

const SEARCH_ITEMS_PER_QUERY = 10;
const MODEL_MAX_TOKENS = 192;
const SNAPSHOT_README_CHARS = 4_000;
const SNAPSHOT_MANIFEST_CHARS = 1_200;
const MODEL_README_CHARS = 360;
const MODEL_MANIFEST_CHARS = 100;

export const SOLUTION_SEARCH_COVERAGE_GAPS = [
  "YouTube not searched",
  "SaaS catalogs not searched",
  "n8n.io catalog not searched",
  "dependency/security advisory review incomplete; CVE not checked",
] as const;

export type SolutionSearchIssueCategory =
  | "network_error"
  | "rate_limited"
  | "http_error"
  | "not_found"
  | "response_too_large"
  | "invalid_response"
  | "incomplete_results"
  | "unexpected_error";

export type SolutionSearchStatus = "ok" | "partial" | "error";

export interface SolutionSnapshotRecord {
  kind: string;
  payload: unknown;
  hash?: string;
}

/** Core adapter: a replay supplies `existing`; first run atomically `save`s. */
export interface SolutionSnapshotPort {
  existing?: SolutionSnapshotRecord | null;
  save(kind: string, payload: Record<string, unknown>): Promise<SolutionSnapshotRecord>;
}

export interface SolutionSearchGitHubPort {
  searchRepositories(query: string, options?: GitHubSearchOptions): Promise<GitHubSearchResult>;
  getReadme(owner: string, repository: string): Promise<GitHubReadmeEvidence>;
  fetchManifest(
    owner: string,
    repository: string,
    manifest: GitHubManifestName,
  ): Promise<GitHubManifestResult>;
}

export interface SolutionSearchInput {
  title: string;
  description?: string;
  domain?: Domain;
}

export interface SolutionSearchOptions {
  agentName: string;
  requestKey: string;
  traceKey?: string;
  assertLease?: () => Promise<void>;
  taskLlm?: TaskLlmSession;
  snapshotPort: SolutionSnapshotPort;
  now?: () => Date;
}

export interface SolutionSearchIssue {
  queryIndex: number;
  category: SolutionSearchIssueCategory;
}

export type SolutionReadmeSnapshot =
  | {
      status: "available";
      sha: string;
      path: string;
      excerpt: string;
      truncated: boolean;
    }
  | { status: "error"; category: SolutionSearchIssueCategory };

export type SolutionManifestSnapshot =
  | {
      name: GitHubManifestName;
      status: "available";
      sha: string;
      excerpt: string;
      truncated: boolean;
    }
  | { name: GitHubManifestName; status: "missing" }
  | { name: GitHubManifestName; status: "error"; category: SolutionSearchIssueCategory };

export type SolutionDenylistMatch =
  "openclaw:repository" | "openclaw:readme" | `openclaw:manifest:${GitHubManifestName}`;

export interface SolutionCandidateSnapshot {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  url: string;
  description: string | null;
  stars: number;
  forks: number;
  archived: boolean;
  language: string | null;
  topics: string[];
  licenseSpdx: string | null;
  pushedAt: string | null;
  updatedAt: string;
  sourceQueryIndexes: number[];
  readme: SolutionReadmeSnapshot;
  manifests: SolutionManifestSnapshot[];
  /** Matches are computed from complete connector-bounded text before excerpts are truncated. */
  denylistMatches: SolutionDenylistMatch[];
}

export interface SolutionSearchSnapshot extends Record<string, unknown> {
  version: 1;
  retrievedAt: string;
  queries: string[];
  coverageGaps: string[];
  searchStatus: SolutionSearchStatus;
  searchIssues: SolutionSearchIssue[];
  candidates: SolutionCandidateSnapshot[];
}

interface DomainQueryRule {
  matches: (brief: string) => boolean;
  queries: readonly [string, string];
}

const TELEGRAM_CRM_RELEVANCE_POLICY = "telegram-crm-v1" as const;
const TELEGRAM_CRM_REQUIRED_SIGNALS = ["telegram", "crm_or_leads"] as const;

type TelegramCrmRequiredSignal = (typeof TELEGRAM_CRM_REQUIRED_SIGNALS)[number];

interface TelegramCrmCandidateDecision {
  accepted: boolean;
  telegram: boolean;
  crmOrLeads: boolean;
  missing: TelegramCrmRequiredSignal[];
  metadataAnchor: boolean;
}

interface TelegramCrmCandidateAudit {
  id: number;
  fullName: string;
  accepted: boolean;
  telegram: boolean;
  crmOrLeads: boolean;
  metadataAnchor: boolean;
  missing: TelegramCrmRequiredSignal[];
}

interface TelegramCrmGateAudit extends Record<string, unknown> {
  policy: typeof TELEGRAM_CRM_RELEVANCE_POLICY;
  active: true;
  required: TelegramCrmRequiredSignal[];
  checked: number;
  accepted: number;
  rejected: number;
  candidates: TelegramCrmCandidateAudit[];
  rejectedByReason: {
    missingTelegram: number;
    missingCrmOrLeads: number;
    missingMetadataAnchor: number;
  };
}

interface AppliedRelevanceGate {
  active: boolean;
  candidates: SolutionCandidateSnapshot[];
  audit?: TelegramCrmGateAudit;
}

function normalizedSignalText(value: string): string {
  return (
    value
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).join(" ");
}

function signalTokens(value: string): Set<string> {
  const normalized = normalizedSignalText(value);
  return new Set(normalized === "" ? [] : normalized.split(" "));
}

function containsSignalPhrase(normalized: string, phrase: string): boolean {
  return ` ${normalized} `.includes(` ${phrase} `);
}

function hasTelegramSignal(value: string): boolean {
  const tokens = signalTokens(value);
  if (tokens.has("telegram") || tokens.has("tg") || tokens.has("тг")) return true;
  return [...tokens].some((token) =>
    /^(?:телеграм|телеграма|телеграме|телеграмом|телеграму)$/.test(token),
  );
}

function hasCrmOrLeadSignal(value: string): boolean {
  const normalized = normalizedSignalText(value);
  const tokens = signalTokens(normalized);
  if (tokens.has("crm") || tokens.has("срм") || tokens.has("leads")) return true;
  if (
    [
      "customer relationship management",
      "lead management",
      "lead qualification",
      "lead capture",
      "lead generation",
      "sales lead",
      "sales leads",
      "sales pipeline",
      "воронка продаж",
      "воронки продаж",
      "воронку продаж",
    ].some((phrase) => containsSignalPhrase(normalized, phrase))
  ) {
    return true;
  }
  return [...tokens].some(
    (token) =>
      /^(?:лид|лида|лиду|лидом|лиде|лиды|лидов|лидам|лидами|лидах)$/.test(token) ||
      token.startsWith("лидогенерац"),
  );
}

function hasTelegramCrmIntent(input: SolutionSearchInput): boolean {
  const brief = `${input.title} ${input.description ?? ""}`;
  return hasTelegramSignal(brief) && hasCrmOrLeadSignal(brief);
}

function hasTelegramQuerySignal(brief: string): boolean {
  if (hasTelegramSignal(brief)) return true;
  const tokens = signalTokens(brief);
  return ["tg", "bot", "bots", "бот", "бота", "боты", "ботов"].some((token) => tokens.has(token));
}

function hasCrmQuerySignal(brief: string): boolean {
  if (hasCrmOrLeadSignal(brief)) return true;
  const tokens = signalTokens(brief);
  return ["sales", "lead", "leads", "pipeline", "продаж", "воронка", "воронки"].some((token) =>
    tokens.has(token),
  );
}

/**
 * Only this local dictionary can influence GitHub queries. The task cannot
 * smuggle a URL, qualifier or model-generated query into the connector.
 */
const DOMAIN_QUERY_RULES: readonly DomainQueryRule[] = [
  {
    matches: hasTelegramQuerySignal,
    queries: ["telegram bot automation", "telegram crm integration"],
  },
  {
    matches: hasCrmQuerySignal,
    queries: ["crm sales automation", "lead management crm"],
  },
  {
    matches: (brief) =>
      /(?:inventory|warehouse|stock|\u0441\u043a\u043b\u0430\u0434|\u043e\u0441\u0442\u0430\u0442\u043a|\u0443\u0447\u0451\u0442|\u0443\u0447\u0435\u0442)/u.test(
        brief,
      ),
    queries: ["inventory warehouse management", "stock accounting erp"],
  },
  {
    matches: (brief) =>
      /(?:workflow|n8n|automation|\u0430\u0432\u0442\u043e\u043c\u0430\u0442\u0438\u0437|\u043f\u0440\u043e\u0446\u0435\u0441\u0441)/u.test(
        brief,
      ),
    queries: ["workflow automation", "n8n workflow templates"],
  },
  {
    matches: (brief) =>
      /(?:marketing|seo|campaign|\u043c\u0430\u0440\u043a\u0435\u0442\u0438\u043d\u0433|\u0440\u0435\u043a\u043b\u0430\u043c|\u043a\u0430\u043c\u043f\u0430\u043d)/u.test(
        brief,
      ),
    queries: ["marketing automation", "open source campaign management"],
  },
  {
    matches: (brief) =>
      /(?:competitor|intelligence|monitoring|\u043a\u043e\u043d\u043a\u0443\u0440\u0435\u043d\u0442|\u0440\u0430\u0437\u0432\u0435\u0434\u043a|\u043c\u043e\u043d\u0438\u0442\u043e\u0440)/u.test(
        brief,
      ),
    queries: ["competitive intelligence", "competitor monitoring"],
  },
  {
    matches: (brief) =>
      /(?:tender|procurement|\u0442\u0435\u043d\u0434\u0435\u0440|\u0437\u0430\u043a\u0443\u043f\u043a)/u.test(
        brief,
      ),
    queries: ["tender procurement platform", "procurement automation"],
  },
  {
    matches: (brief) =>
      /(?:accounting|invoice|finance|\u0431\u0443\u0445\u0433\u0430\u043b\u0442|\u0441\u0447\u0451\u0442|\u0441\u0447\u0435\u0442|\u0444\u0438\u043d\u0430\u043d\u0441)/u.test(
        brief,
      ),
    queries: ["open source accounting erp", "invoice automation"],
  },
] as const;

const SEARCH_QUALIFIERS = "in:name,description,readme stars:>=30 archived:false";

/** Deterministic one-or-two-query route; no task text is copied into a query. */
export function buildSolutionQueries(input: SolutionSearchInput): string[] {
  const brief = `${input.title} ${input.description ?? ""}`.normalize("NFKC").toLowerCase();
  if (hasTelegramCrmIntent(input)) {
    return ["telegram crm", "telegram lead management"].map(
      (base) => `${base} ${SEARCH_QUALIFIERS}`,
    );
  }
  const matched = DOMAIN_QUERY_RULES.filter((rule) => rule.matches(brief));
  const bases: string[] = [];
  if (matched.length === 0) {
    bases.push("open source business automation");
  } else if (matched.length === 1) {
    bases.push(...matched[0].queries);
  } else {
    bases.push(matched[0].queries[0], matched[1].queries[0]);
  }
  return [...new Set(bases)].slice(0, 2).map((base) => `${base} ${SEARCH_QUALIFIERS}`);
}

function issueCategory(error: unknown): SolutionSearchIssueCategory {
  if (!(error instanceof GitHubConnectorError)) return "unexpected_error";
  if (error.code === "network_error") return "network_error";
  if (error.code === "rate_limited") return "rate_limited";
  if (error.code === "response_too_large") return "response_too_large";
  if (error.code === "invalid_response" || error.code === "invalid_input") {
    return "invalid_response";
  }
  return error.status === 404 ? "not_found" : "http_error";
}

function excerpt(text: string, limit: number): { text: string; truncated: boolean } {
  const normalized = text.split("\u0000").join("").trim();
  return {
    text: normalized.slice(0, limit),
    truncated: normalized.length > limit,
  };
}

function containsOpenClaw(value: string): boolean {
  return value.toLowerCase().includes("openclaw");
}

async function readCandidate(
  connector: SolutionSearchGitHubPort,
  repository: GitHubRepositoryEvidence,
  sourceQueryIndexes: number[],
  assertLease: (() => Promise<void>) | undefined,
): Promise<SolutionCandidateSnapshot> {
  const denylistMatches: SolutionDenylistMatch[] = [];
  if (
    containsOpenClaw(
      [repository.fullName, repository.description ?? "", ...repository.topics].join("\n"),
    )
  ) {
    denylistMatches.push("openclaw:repository");
  }
  let readme: SolutionReadmeSnapshot;
  await assertLease?.();
  try {
    const value = await connector.getReadme(repository.owner, repository.name);
    if (containsOpenClaw(value.text)) denylistMatches.push("openclaw:readme");
    const bounded = excerpt(value.text, SNAPSHOT_README_CHARS);
    readme = {
      status: "available",
      sha: value.sha,
      path: value.path,
      excerpt: bounded.text,
      truncated: bounded.truncated,
    };
  } catch (error) {
    readme = { status: "error", category: issueCategory(error) };
  }

  const manifests: SolutionManifestSnapshot[] = [];
  for (const name of GITHUB_MANIFEST_NAMES) {
    await assertLease?.();
    try {
      const value = await connector.fetchManifest(repository.owner, repository.name, name);
      if (!value.found) {
        manifests.push({ name, status: "missing" });
        continue;
      }
      if (containsOpenClaw(value.evidence.text)) {
        denylistMatches.push(`openclaw:manifest:${name}`);
      }
      const bounded = excerpt(value.evidence.text, SNAPSHOT_MANIFEST_CHARS);
      manifests.push({
        name,
        status: "available",
        sha: value.evidence.sha,
        excerpt: bounded.text,
        truncated: bounded.truncated,
      });
    } catch (error) {
      manifests.push({ name, status: "error", category: issueCategory(error) });
    }
  }

  return {
    id: repository.id,
    owner: repository.owner,
    name: repository.name,
    fullName: repository.fullName,
    url: repository.url,
    description: repository.description,
    stars: repository.stars,
    forks: repository.forks,
    archived: repository.archived,
    language: repository.language,
    topics: repository.topics,
    licenseSpdx: repository.licenseSpdx,
    pushedAt: repository.pushedAt,
    updatedAt: repository.updatedAt,
    sourceQueryIndexes,
    readme,
    manifests,
    denylistMatches,
  };
}

function repositoryMetadataSignalCount(repository: GitHubRepositoryEvidence): number {
  // Owner is intentionally excluded: an organization name must not make an
  // unrelated repository look relevant. Only candidate-owned product fields
  // may influence this bounded preselection hint.
  const metadata = [repository.name, repository.description ?? "", ...repository.topics].join("\n");
  return Number(hasTelegramSignal(metadata)) + Number(hasCrmOrLeadSignal(metadata));
}

async function gatherSnapshot(
  connector: SolutionSearchGitHubPort,
  input: SolutionSearchInput,
  now: () => Date,
  assertLease: (() => Promise<void>) | undefined,
): Promise<SolutionSearchSnapshot> {
  const queries = buildSolutionQueries(input);
  const searchIssues: SolutionSearchIssue[] = [];
  const found = new Map<
    number,
    { repository: GitHubRepositoryEvidence; queryIndexes: number[]; firstSeenOrder: number }
  >();
  const fullNames = new Set<string>();
  let completedSearches = 0;

  for (let queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
    await assertLease?.();
    try {
      const result = await connector.searchRepositories(queries[queryIndex], {
        items: SEARCH_ITEMS_PER_QUERY,
      });
      completedSearches += 1;
      if (result.incomplete) {
        searchIssues.push({ queryIndex, category: "incomplete_results" });
      }
      for (const repository of result.items) {
        const prior = found.get(repository.id);
        if (prior) {
          if (!prior.queryIndexes.includes(queryIndex)) prior.queryIndexes.push(queryIndex);
          continue;
        }
        const normalizedName = repository.fullName.toLowerCase();
        if (fullNames.has(normalizedName)) continue;
        fullNames.add(normalizedName);
        found.set(repository.id, {
          repository,
          queryIndexes: [queryIndex],
          firstSeenOrder: found.size,
        });
      }
    } catch (error) {
      searchIssues.push({ queryIndex, category: issueCategory(error) });
    }
  }

  const applyTelegramCrmHint = hasTelegramCrmIntent(input);
  const pool = [...found.values()].sort((left, right) => {
    const metadataSignalDifference = applyTelegramCrmHint
      ? repositoryMetadataSignalCount(right.repository) -
        repositoryMetadataSignalCount(left.repository)
      : 0;
    return (
      metadataSignalDifference ||
      right.repository.stars - left.repository.stars ||
      left.firstSeenOrder - right.firstSeenOrder ||
      left.repository.id - right.repository.id
    );
  });
  const selected: typeof pool = [];
  const selectedIds = new Set<number>();
  const take = (candidate: (typeof pool)[number] | undefined): void => {
    if (candidate === undefined || selectedIds.has(candidate.repository.id)) return;
    selected.push(candidate);
    selectedIds.add(candidate.repository.id);
  };

  // Coverage round: every query with an exclusive hit receives one slot before
  // global fill. Shared hits are used only when that query has no exclusive
  // candidate, so a broad first query cannot starve the second domain.
  for (let queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
    if (selected.length >= SOLUTION_SEARCH_MAX_CANDIDATES) break;
    const eligible = pool.filter(
      (candidate) =>
        candidate.queryIndexes.includes(queryIndex) && !selectedIds.has(candidate.repository.id),
    );
    take(
      applyTelegramCrmHint
        ? eligible[0]
        : (eligible.find(
            (candidate) =>
              candidate.queryIndexes.length === 1 && candidate.queryIndexes[0] === queryIndex,
          ) ?? eligible[0]),
    );
  }
  for (const candidate of pool) {
    if (selected.length >= SOLUTION_SEARCH_MAX_CANDIDATES) break;
    take(candidate);
  }

  const candidates: SolutionCandidateSnapshot[] = [];
  for (const selectedRepository of selected) {
    candidates.push(
      await readCandidate(
        connector,
        selectedRepository.repository,
        selectedRepository.queryIndexes,
        assertLease,
      ),
    );
  }

  const failedSearches = queries.length - completedSearches;
  const hasEvidenceErrors = candidates.some(
    (candidate) =>
      candidate.readme.status === "error" ||
      candidate.manifests.some((manifest) => manifest.status === "error"),
  );
  const searchStatus: SolutionSearchStatus =
    completedSearches === 0
      ? "error"
      : failedSearches > 0 || searchIssues.length > 0 || hasEvidenceErrors
        ? "partial"
        : "ok";
  return {
    version: 1,
    retrievedAt: now().toISOString(),
    queries,
    coverageGaps: [...SOLUTION_SEARCH_COVERAGE_GAPS],
    searchStatus,
    searchIssues,
    candidates,
  };
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function safeString(value: unknown, maximum: number, allowEmpty = false): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    value.length <= maximum &&
    !hasDisallowedControl(value)
  );
}

function hasDisallowedControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (
      (code >= 0 && code <= 8) ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      code === 127
    ) {
      return true;
    }
  }
  return false;
}

function safeInteger(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function canonicalIso(value: unknown, nullable = false): value is string | null {
  if (nullable && value === null) return true;
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

const ISSUE_CATEGORIES = new Set<SolutionSearchIssueCategory>([
  "network_error",
  "rate_limited",
  "http_error",
  "not_found",
  "response_too_large",
  "invalid_response",
  "incomplete_results",
  "unexpected_error",
]);

function validCategory(value: unknown): value is SolutionSearchIssueCategory {
  return typeof value === "string" && ISSUE_CATEGORIES.has(value as SolutionSearchIssueCategory);
}

function validSha(value: unknown): value is string {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

function validManifest(value: unknown, expectedName: GitHubManifestName): boolean {
  if (!plainRecord(value) || value.name !== expectedName || !safeString(value.status, 16))
    return false;
  if (value.status === "missing") return exactKeys(value, ["name", "status"]);
  if (value.status === "error") {
    return exactKeys(value, ["name", "status", "category"]) && validCategory(value.category);
  }
  return (
    value.status === "available" &&
    exactKeys(value, ["name", "status", "sha", "excerpt", "truncated"]) &&
    validSha(value.sha) &&
    safeString(value.excerpt, SNAPSHOT_MANIFEST_CHARS, true) &&
    typeof value.truncated === "boolean"
  );
}

function validReadme(value: unknown): boolean {
  if (!plainRecord(value) || !safeString(value.status, 16)) return false;
  if (value.status === "error") {
    return exactKeys(value, ["status", "category"]) && validCategory(value.category);
  }
  return (
    value.status === "available" &&
    exactKeys(value, ["status", "sha", "path", "excerpt", "truncated"]) &&
    validSha(value.sha) &&
    safeString(value.path, 4_096) &&
    !value.path.startsWith("/") &&
    !value.path.includes("\\") &&
    !value.path.split("/").some((part) => part === "" || part === "." || part === "..") &&
    safeString(value.excerpt, SNAPSHOT_README_CHARS, true) &&
    typeof value.truncated === "boolean"
  );
}

const DENYLIST_MATCHES = new Set<SolutionDenylistMatch>([
  "openclaw:repository",
  "openclaw:readme",
  ...GITHUB_MANIFEST_NAMES.map((name): SolutionDenylistMatch => `openclaw:manifest:${name}`),
]);

function validDenylistMatches(value: unknown): value is SolutionDenylistMatch[] {
  return (
    Array.isArray(value) &&
    value.length <= DENYLIST_MATCHES.size &&
    value.every(
      (match) => typeof match === "string" && DENYLIST_MATCHES.has(match as SolutionDenylistMatch),
    ) &&
    new Set(value).size === value.length
  );
}

function consistentDenylistMatches(candidate: SolutionCandidateSnapshot): boolean {
  const matches = new Set(candidate.denylistMatches);
  const repositoryMatch = containsOpenClaw(
    [candidate.fullName, candidate.description ?? "", ...candidate.topics].join("\n"),
  );
  if (matches.has("openclaw:repository") !== repositoryMatch) return false;

  const readmeMatch = matches.has("openclaw:readme");
  if (candidate.readme.status === "error") {
    if (readmeMatch) return false;
  } else {
    const visible = containsOpenClaw(candidate.readme.excerpt);
    if ((visible && !readmeMatch) || (!candidate.readme.truncated && visible !== readmeMatch)) {
      return false;
    }
  }

  for (const manifest of candidate.manifests) {
    const key: SolutionDenylistMatch = `openclaw:manifest:${manifest.name}`;
    const matched = matches.has(key);
    if (manifest.status !== "available") {
      if (matched) return false;
      continue;
    }
    const visible = containsOpenClaw(manifest.excerpt);
    if ((visible && !matched) || (!manifest.truncated && visible !== matched)) return false;
  }
  return true;
}

function validCandidate(value: unknown): value is SolutionCandidateSnapshot {
  if (!plainRecord(value)) return false;
  if (
    !exactKeys(value, [
      "id",
      "owner",
      "name",
      "fullName",
      "url",
      "description",
      "stars",
      "forks",
      "archived",
      "language",
      "topics",
      "licenseSpdx",
      "pushedAt",
      "updatedAt",
      "sourceQueryIndexes",
      "readme",
      "manifests",
      "denylistMatches",
    ])
  ) {
    return false;
  }
  if (
    !safeInteger(value.id, 1) ||
    !safeString(value.owner, 39) ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(value.owner) ||
    !safeString(value.name, 100) ||
    !/^[A-Za-z0-9._-]+$/.test(value.name) ||
    value.fullName !== `${value.owner}/${value.name}` ||
    value.url !== `https://github.com/${value.fullName}` ||
    !(value.description === null || safeString(value.description, 2_000, true)) ||
    !safeInteger(value.stars) ||
    !safeInteger(value.forks) ||
    typeof value.archived !== "boolean" ||
    !(value.language === null || safeString(value.language, 128)) ||
    !(value.licenseSpdx === null || safeString(value.licenseSpdx, 128)) ||
    !canonicalIso(value.pushedAt, true) ||
    !canonicalIso(value.updatedAt) ||
    !Array.isArray(value.topics) ||
    value.topics.length > 20 ||
    !value.topics.every((topic) => safeString(topic, 50)) ||
    !Array.isArray(value.sourceQueryIndexes) ||
    value.sourceQueryIndexes.length === 0 ||
    value.sourceQueryIndexes.length > 2 ||
    !value.sourceQueryIndexes.every((index) => safeInteger(index) && index < 2) ||
    new Set(value.sourceQueryIndexes).size !== value.sourceQueryIndexes.length ||
    !validReadme(value.readme) ||
    !Array.isArray(value.manifests) ||
    value.manifests.length !== GITHUB_MANIFEST_NAMES.length ||
    !value.manifests.every((manifest, index) =>
      validManifest(manifest, GITHUB_MANIFEST_NAMES[index]),
    ) ||
    !validDenylistMatches(value.denylistMatches)
  ) {
    return false;
  }
  const candidate = value as unknown as SolutionCandidateSnapshot;
  if (!consistentDenylistMatches(candidate)) return false;
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8") <= 20_000;
  } catch {
    return false;
  }
}

/** Strict parser for Core replay. It validates but does not replace stored data. */
export function parseSolutionSnapshot(payload: unknown): SolutionSearchSnapshot {
  if (!plainRecord(payload)) throw new Error("solution-search snapshot must be a plain object");
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    throw new Error("solution-search snapshot is not serializable");
  }
  if (Buffer.byteLength(serialized, "utf8") > SOLUTION_SEARCH_SNAPSHOT_MAX_BYTES) {
    throw new Error("solution-search snapshot exceeds 64 KiB");
  }
  const queryCount = Array.isArray(payload.queries) ? payload.queries.length : -1;
  if (
    !exactKeys(payload, [
      "version",
      "retrievedAt",
      "queries",
      "coverageGaps",
      "searchStatus",
      "searchIssues",
      "candidates",
    ]) ||
    payload.version !== 1 ||
    !canonicalIso(payload.retrievedAt) ||
    !Array.isArray(payload.queries) ||
    payload.queries.length < 1 ||
    payload.queries.length > 2 ||
    !payload.queries.every(
      (query) => safeString(query, 256) && query.endsWith(SEARCH_QUALIFIERS),
    ) ||
    !Array.isArray(payload.coverageGaps) ||
    payload.coverageGaps.length !== SOLUTION_SEARCH_COVERAGE_GAPS.length ||
    !payload.coverageGaps.every((gap, index) => gap === SOLUTION_SEARCH_COVERAGE_GAPS[index]) ||
    !safeString(payload.searchStatus, 16) ||
    !(["ok", "partial", "error"] as const).includes(payload.searchStatus as SolutionSearchStatus) ||
    !Array.isArray(payload.searchIssues) ||
    payload.searchIssues.length > 4 ||
    !payload.searchIssues.every(
      (issue) =>
        plainRecord(issue) &&
        exactKeys(issue, ["queryIndex", "category"]) &&
        safeInteger(issue.queryIndex) &&
        issue.queryIndex < queryCount &&
        validCategory(issue.category),
    ) ||
    !Array.isArray(payload.candidates) ||
    payload.candidates.length > SOLUTION_SEARCH_MAX_CANDIDATES ||
    !payload.candidates.every(validCandidate)
  ) {
    throw new Error("solution-search snapshot is corrupt");
  }
  const candidates = payload.candidates as SolutionCandidateSnapshot[];
  const queries = payload.queries as string[];
  const issues = payload.searchIssues as SolutionSearchIssue[];
  const hasEvidenceErrors = candidates.some(
    (candidate) =>
      candidate.readme.status === "error" ||
      candidate.manifests.some((manifest) => manifest.status === "error"),
  );
  const hasPartialEvidence = issues.length > 0 || hasEvidenceErrors;
  if (
    new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length ||
    new Set(candidates.map((candidate) => candidate.fullName.toLowerCase())).size !==
      candidates.length ||
    candidates.some((candidate) =>
      candidate.sourceQueryIndexes.some((queryIndex) => queryIndex >= queries.length),
    ) ||
    (payload.searchStatus === "ok" && hasPartialEvidence) ||
    (payload.searchStatus === "partial" && !hasPartialEvidence) ||
    (payload.searchStatus === "error" &&
      (candidates.length > 0 || issues.length !== queries.length))
  ) {
    throw new Error("solution-search snapshot contains inconsistent evidence");
  }
  return payload as SolutionSearchSnapshot;
}

function parseStoredSnapshot(record: SolutionSnapshotRecord): SolutionSearchSnapshot {
  if (record.kind !== SOLUTION_SEARCH_SNAPSHOT_KIND) {
    throw new Error(`unexpected solution-search snapshot kind: ${record.kind}`);
  }
  return parseSolutionSnapshot(record.payload);
}

function telegramCrmCandidateDecision(
  candidate: SolutionCandidateSnapshot,
): TelegramCrmCandidateDecision {
  const metadata = [candidate.name, candidate.description ?? "", ...candidate.topics].join("\n");
  const readme = candidate.readme.status === "available" ? candidate.readme.excerpt : "";
  const telegramInMetadata = hasTelegramSignal(metadata);
  const crmOrLeadsInMetadata = hasCrmOrLeadSignal(metadata);
  const hasTelegram = telegramInMetadata || hasTelegramSignal(readme);
  const hasCrmOrLeads = crmOrLeadsInMetadata || hasCrmOrLeadSignal(readme);
  const metadataAnchor = telegramInMetadata || crmOrLeadsInMetadata;
  const missing: TelegramCrmRequiredSignal[] = [];
  if (!hasTelegram) missing.push("telegram");
  if (!hasCrmOrLeads) missing.push("crm_or_leads");
  return {
    accepted: missing.length === 0 && metadataAnchor,
    telegram: hasTelegram,
    crmOrLeads: hasCrmOrLeads,
    missing,
    metadataAnchor,
  };
}

function applyRelevanceGate(
  input: SolutionSearchInput,
  candidates: SolutionCandidateSnapshot[],
): AppliedRelevanceGate {
  if (!hasTelegramCrmIntent(input)) return { active: false, candidates };

  const accepted: SolutionCandidateSnapshot[] = [];
  let missingTelegram = 0;
  let missingCrmOrLeads = 0;
  let missingMetadataAnchor = 0;
  const candidateAudit: TelegramCrmCandidateAudit[] = [];
  for (const candidate of candidates) {
    const decision = telegramCrmCandidateDecision(candidate);
    candidateAudit.push({
      id: candidate.id,
      fullName: candidate.fullName,
      accepted: decision.accepted,
      telegram: decision.telegram,
      crmOrLeads: decision.crmOrLeads,
      metadataAnchor: decision.metadataAnchor,
      missing: [...decision.missing],
    });
    if (decision.accepted) {
      accepted.push(candidate);
      continue;
    }
    if (decision.missing.includes("telegram")) missingTelegram += 1;
    if (decision.missing.includes("crm_or_leads")) missingCrmOrLeads += 1;
    if (!decision.metadataAnchor) missingMetadataAnchor += 1;
  }

  return {
    active: true,
    candidates: accepted,
    audit: {
      policy: TELEGRAM_CRM_RELEVANCE_POLICY,
      active: true,
      required: [...TELEGRAM_CRM_REQUIRED_SIGNALS],
      checked: candidates.length,
      accepted: accepted.length,
      rejected: candidates.length - accepted.length,
      candidates: candidateAudit,
      rejectedByReason: {
        missingTelegram,
        missingCrmOrLeads,
        missingMetadataAnchor,
      },
    },
  };
}

interface ModelScores {
  readiness: number;
  cis: number;
  relevance: number;
}

function parseModelScores(
  text: string,
  candidateIds: readonly number[],
): Map<number, ModelScores> | null {
  let value: unknown;
  try {
    value = JSON.parse(text.trim()) as unknown;
  } catch {
    return null;
  }
  if (!plainRecord(value) || !exactKeys(value, ["rankings"]) || !Array.isArray(value.rankings)) {
    return null;
  }
  if (value.rankings.length !== candidateIds.length) return null;
  const allowed = new Set(candidateIds);
  const result = new Map<number, ModelScores>();
  for (const item of value.rankings) {
    if (
      !plainRecord(item) ||
      !exactKeys(item, ["id", "readiness", "cis", "relevance"]) ||
      !safeInteger(item.id, 1) ||
      !allowed.has(item.id) ||
      result.has(item.id) ||
      ![item.readiness, item.cis, item.relevance].every(
        (score) => safeInteger(score, 1) && score <= 5,
      )
    ) {
      return null;
    }
    result.set(item.id, {
      readiness: item.readiness as number,
      cis: item.cis as number,
      relevance: item.relevance as number,
    });
  }
  return result.size === allowed.size ? result : null;
}

function evidenceText(candidate: SolutionCandidateSnapshot): string {
  return [
    candidate.fullName,
    candidate.description ?? "",
    candidate.topics.join(" "),
    candidate.readme.status === "available" ? candidate.readme.excerpt : "",
    ...candidate.manifests.map((manifest) =>
      manifest.status === "available" ? manifest.excerpt : "",
    ),
  ]
    .join("\n")
    .toLowerCase();
}

function deterministicScores(candidate: SolutionCandidateSnapshot): ModelScores {
  const text = evidenceText(candidate);
  const hasInstall =
    /(?:install|setup|quick ?start|docker compose|\u0443\u0441\u0442\u0430\u043d\u043e\u0432|\u0437\u0430\u043f\u0443\u0441\u043a)/u.test(
      text,
    );
  const readiness = candidate.archived
    ? 1
    : candidate.readme.status === "available"
      ? hasInstall
        ? 4
        : 3
      : 2;
  const hasCyrillic = /[\u0400-\u04ff]/u.test(text);
  const hasCisIntegration =
    /(?:bitrix|amo ?crm|kommo|moysklad|\u043c\u043e\u0439\u0441\u043a\u043b\u0430\u0434|1c|1\u0441|didox)/u.test(
      text,
    );
  const cis = hasCyrillic ? 4 : hasCisIntegration ? 3 : 2;
  return { readiness, cis, relevance: 3 };
}

const OPEN_SOURCE_LICENSES = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MPL-2.0",
  "GPL-2.0",
  "GPL-3.0",
  "LGPL-2.1",
  "LGPL-3.0",
  "AGPL-3.0",
  "Unlicense",
]);

function costScore(candidate: SolutionCandidateSnapshot): number {
  return candidate.licenseSpdx !== null && OPEN_SOURCE_LICENSES.has(candidate.licenseSpdx) ? 5 : 3;
}

function maintenanceScore(candidate: SolutionCandidateSnapshot, retrievedAt: string): number {
  if (candidate.archived || candidate.pushedAt === null) return 1;
  const ageDays = Math.max(
    0,
    (Date.parse(retrievedAt) - Date.parse(candidate.pushedAt)) / (24 * 60 * 60 * 1_000),
  );
  if (ageDays <= 90 && candidate.stars >= 1_000) return 5;
  if (ageDays <= 270 && candidate.stars >= 100) return 4;
  if (ageDays <= 365) return 3;
  if (ageDays <= 730) return 2;
  return 1;
}

function denylisted(candidate: SolutionCandidateSnapshot): boolean {
  return candidate.denylistMatches.length > 0;
}

interface RankedSolution {
  candidate: SolutionCandidateSnapshot;
  readiness: number;
  cis: number;
  cost: number;
  relevance: number;
  maintenance: number;
  total: number;
  denylisted: boolean;
}

function rankSolutions(
  snapshot: SolutionSearchSnapshot,
  modelScores: Map<number, ModelScores> | null,
): RankedSolution[] {
  return snapshot.candidates
    .map((candidate) => {
      const scores = modelScores?.get(candidate.id) ?? deterministicScores(candidate);
      const blocked = denylisted(candidate);
      const readiness = blocked ? Math.min(2, scores.readiness) : scores.readiness;
      const cost = costScore(candidate);
      const maintenance = maintenanceScore(candidate, snapshot.retrievedAt);
      return {
        candidate,
        readiness,
        cis: scores.cis,
        cost,
        relevance: scores.relevance,
        maintenance,
        total: readiness + scores.cis + cost + scores.relevance + maintenance,
        denylisted: blocked,
      };
    })
    .sort(
      (left, right) =>
        right.total - left.total ||
        right.relevance - left.relevance ||
        right.maintenance - left.maintenance ||
        right.candidate.stars - left.candidate.stars ||
        left.candidate.id - right.candidate.id,
    );
}

function modelEvidence(input: SolutionSearchInput, snapshot: SolutionSearchSnapshot): string {
  return JSON.stringify({
    task: {
      title: input.title.slice(0, 240),
      description: (input.description ?? "").slice(0, 500),
      ...(input.domain ? { domain: input.domain } : {}),
    },
    candidates: snapshot.candidates.map((candidate) => ({
      id: candidate.id,
      fullName: candidate.fullName,
      description: (candidate.description ?? "").slice(0, 240),
      stars: candidate.stars,
      archived: candidate.archived,
      language: candidate.language,
      topics: candidate.topics.slice(0, 8),
      licenseSpdx: candidate.licenseSpdx,
      pushedAt: candidate.pushedAt,
      readme:
        candidate.readme.status === "available"
          ? candidate.readme.excerpt.slice(0, MODEL_README_CHARS)
          : { error: candidate.readme.category },
      manifests: candidate.manifests.map((manifest) =>
        manifest.status === "available"
          ? { name: manifest.name, excerpt: manifest.excerpt.slice(0, MODEL_MANIFEST_CHARS) }
          : { name: manifest.name, status: manifest.status },
      ),
    })),
  });
}

function safeTaskLabel(value: string): string {
  const normalized = value
    .replace(
      /https?:\/\/\S+/giu,
      "[\u0441\u0441\u044b\u043b\u043a\u0430 \u0438\u0437 \u0437\u0430\u0434\u0430\u0447\u0438 \u0441\u043a\u0440\u044b\u0442\u0430]",
    )
    .split("")
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127 ? " " : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return (
    normalized.slice(0, 120) ||
    "\u043f\u043e\u0440\u0443\u0447\u0435\u043d\u043d\u043e\u0439 \u0437\u0430\u0434\u0430\u0447\u0435"
  );
}

function priceLabel(candidate: SolutionCandidateSnapshot): string {
  return candidate.licenseSpdx !== null && OPEN_SOURCE_LICENSES.has(candidate.licenseSpdx)
    ? `OSS ${candidate.licenseSpdx}; \u0445\u043e\u0441\u0442\u0438\u043d\u0433/API \u043d\u0435 \u043f\u0440\u043e\u0432\u0435\u0440\u0435\u043d\u044b`
    : "\u0441\u0442\u043e\u0438\u043c\u043e\u0441\u0442\u044c \u043d\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043d\u0430; \u043b\u0438\u0446\u0435\u043d\u0437\u0438\u044e \u043f\u0440\u043e\u0432\u0435\u0440\u0438\u0442\u044c";
}

function ownerReport(
  input: SolutionSearchInput,
  snapshot: SolutionSearchSnapshot,
  ranked: RankedSolution[],
  modelResult: CallModelResult | null,
  modelRankingValid: boolean,
  relevanceGate: AppliedRelevanceGate,
): string {
  const lines = [
    `# GitHub-\u0440\u0435\u0448\u0435\u043d\u0438\u044f: ${safeTaskLabel(input.title)}`,
  ];
  if (modelResult === null) {
    lines.push(
      relevanceGate.audit && relevanceGate.audit.checked > 0
        ? `LLM ranking not called: no candidates passed ${TELEGRAM_CRM_RELEVANCE_POLICY}.`
        : "LLM ranking not called: no candidates.",
    );
  } else if (modelResult.ok && modelRankingValid) {
    lines.push("LLM ranking valid.");
  } else if (modelResult.ok) {
    lines.push("LLM output invalid/rejected; deterministic fallback.");
  } else {
    lines.push("LLM ranking unavailable; deterministic fallback.");
  }
  lines.push(
    `Coverage: GitHub ${snapshot.retrievedAt}, status=${snapshot.searchStatus}. Gaps: ${snapshot.coverageGaps.join("; ")}. CVE/security advisories not checked.`,
  );
  if (relevanceGate.audit) {
    lines.push(
      `Relevance gate ${TELEGRAM_CRM_RELEVANCE_POLICY}: accepted ${relevanceGate.audit.accepted}/${relevanceGate.audit.checked}; required persisted evidence of Telegram + CRM/leads with a metadata anchor.`,
    );
  }
  if (snapshot.searchStatus === "partial") {
    const categories = new Set<SolutionSearchIssueCategory>(
      snapshot.searchIssues.map((issue) => issue.category),
    );
    for (const candidate of snapshot.candidates) {
      if (candidate.readme.status === "error") categories.add(candidate.readme.category);
      for (const manifest of candidate.manifests) {
        if (manifest.status === "error") categories.add(manifest.category);
      }
    }
    lines.push(
      `GitHub evidence \u043f\u043e\u043b\u0443\u0447\u0435\u043d\u044b \u0447\u0430\u0441\u0442\u0438\u0447\u043d\u043e (${[...categories].sort().join(", ") || "unknown"}); \u043d\u0435\u043f\u043e\u043b\u043d\u043e\u0442\u0443 \u043d\u0435\u043b\u044c\u0437\u044f \u0441\u0447\u0438\u0442\u0430\u0442\u044c \u043e\u0442\u0441\u0443\u0442\u0441\u0442\u0432\u0438\u0435\u043c \u0440\u0435\u0448\u0435\u043d\u0438\u0439.`,
    );
  }
  if (snapshot.searchStatus === "error") {
    lines.push(
      "\u041f\u043e\u0438\u0441\u043a GitHub \u043d\u0435 \u0437\u0430\u0432\u0435\u0440\u0448\u0451\u043d. \u042d\u0442\u043e \u043e\u0448\u0438\u0431\u043a\u0430 \u043f\u043e\u043a\u0440\u044b\u0442\u0438\u044f, \u0430 \u043d\u0435 \u0434\u043e\u043a\u0430\u0437\u0430\u0442\u0435\u043b\u044c\u0441\u0442\u0432\u043e \u043e\u0442\u0441\u0443\u0442\u0441\u0442\u0432\u0438\u044f \u0440\u0435\u0448\u0435\u043d\u0438\u0439.",
    );
  } else if (
    ranked.length === 0 &&
    relevanceGate.audit !== undefined &&
    relevanceGate.audit.checked > 0
  ) {
    lines.push(
      snapshot.searchStatus === "partial"
        ? "GitHub evidence неполны: в доступном срезе ни один кандидат не доказал одновременно Telegram + CRM/лиды. Это не доказывает отсутствие решений."
        : "GitHub вернул кандидатов, но ни один не доказал одновременно Telegram + CRM/лиды по сохранённым metadata/README; отклонённые репозитории не рекомендуются.",
    );
  } else if (ranked.length === 0 && snapshot.searchStatus === "partial") {
    lines.push(
      "\u041f\u043e\u0438\u0441\u043a GitHub \u0437\u0430\u0432\u0435\u0440\u0448\u0451\u043d \u043b\u0438\u0448\u044c \u0447\u0430\u0441\u0442\u0438\u0447\u043d\u043e; \u0432 \u043d\u0435\u043f\u043e\u043b\u043d\u043e\u043c \u0441\u0440\u0435\u0437\u0435 \u043a\u0430\u043d\u0434\u0438\u0434\u0430\u0442\u043e\u0432 \u043d\u0435\u0442. \u042d\u0442\u043e \u043d\u0435 \u0434\u043e\u043a\u0430\u0437\u044b\u0432\u0430\u0435\u0442 \u043e\u0442\u0441\u0443\u0442\u0441\u0442\u0432\u0438\u0435 \u0440\u0435\u0448\u0435\u043d\u0438\u0439.",
    );
  } else if (ranked.length === 0) {
    lines.push(
      "\u0412 \u043f\u043e\u043a\u0440\u044b\u0442\u043e\u043c GitHub-\u0441\u0440\u0435\u0437\u0435 \u043a\u0430\u043d\u0434\u0438\u0434\u0430\u0442\u043e\u0432 \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u043e; \u044d\u0442\u043e \u043d\u0435 \u043e\u0437\u043d\u0430\u0447\u0430\u0435\u0442, \u0447\u0442\u043e \u0433\u043e\u0442\u043e\u0432\u043e\u0433\u043e \u0440\u0435\u0448\u0435\u043d\u0438\u044f \u043d\u0435\u0442 \u0432\u043e\u043e\u0431\u0449\u0435.",
    );
  } else {
    for (let index = 0; index < ranked.length; index += 1) {
      const item = ranked[index];
      const pushed = item.candidate.pushedAt ?? "\u043d\u0435 \u0443\u043a\u0430\u0437\u0430\u043d";
      lines.push(
        `${index + 1}. ${item.candidate.fullName} \u2014 ${item.total}/25${item.denylisted ? " \ud83d\uded1 OpenClaw: \u0433\u043e\u0442\u043e\u0432\u043d\u043e\u0441\u0442\u044c\u22642" : ""}\n` +
          `${item.candidate.url} | \u2b50${item.candidate.stars} | pushed ${pushed} | ${priceLabel(item.candidate)}\n` +
          `\u041e\u0446\u0435\u043d\u043a\u0438: \u0433\u043e\u0442\u043e\u0432\u043d\u043e\u0441\u0442\u044c ${item.readiness}, CIS ${item.cis}, \u0441\u0442\u043e\u0438\u043c\u043e\u0441\u0442\u044c ${item.cost}, \u0440\u0435\u043b\u0435\u0432\u0430\u043d\u0442\u043d\u043e\u0441\u0442\u044c ${item.relevance}, \u0441\u043e\u043f\u0440\u043e\u0432\u043e\u0436\u0434\u0435\u043d\u0438\u0435 ${item.maintenance}.`,
      );
    }
    lines.push(
      `\u0420\u0435\u043a\u043e\u043c\u0435\u043d\u0434\u0430\u0446\u0438\u044f: \u0441\u043d\u0430\u0447\u0430 \u0432\u0440\u0443\u0447\u043d\u0443\u044e \u043f\u0440\u043e\u0432\u0435\u0440\u0438\u0442\u044c ${ranked[0].candidate.fullName}; \u0443\u0441\u0442\u0430\u043d\u043e\u0432\u043a\u0430 \u043d\u0435 \u0437\u0430\u043f\u0443\u0441\u043a\u0430\u043b\u0430\u0441\u044c.`,
    );
  }
  const bounded: string[] = [];
  let length = 0;
  for (const line of lines) {
    const nextLength = length + (bounded.length === 0 ? 0 : 1) + line.length;
    if (nextLength > 2_000) {
      const omitted =
        "\u2026 \u041e\u0441\u0442\u0430\u043b\u044c\u043d\u044b\u0435 ranked rows \u043e\u043f\u0443\u0449\u0435\u043d\u044b \u0438\u0437 owner report; \u0444\u0430\u043a\u0442\u044b \u0441\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u044b \u0432 structured evidence.";
      const omittedLength = length + (bounded.length === 0 ? 0 : 1) + omitted.length;
      if (omittedLength <= 2_000) bounded.push(omitted);
      break;
    }
    bounded.push(line);
    length = nextLength;
  }
  return bounded.join("\n");
}

function noCandidateAction(
  snapshot: SolutionSearchSnapshot,
  relevanceGate: AppliedRelevanceGate,
): string {
  if (snapshot.searchStatus === "error") {
    return "\u041f\u043e\u0438\u0441\u043a GitHub \u043d\u0435 \u0437\u0430\u0432\u0435\u0440\u0448\u0451\u043d: \u0438\u0441\u0442\u043e\u0447\u043d\u0438\u043a \u043d\u0435 \u043e\u0442\u0432\u0435\u0442\u0438\u043b. \u042d\u0442\u043e \u043d\u0435 \u043e\u0437\u043d\u0430\u0447\u0430\u0435\u0442, \u0447\u0442\u043e \u0433\u043e\u0442\u043e\u0432\u044b\u0445 \u0440\u0435\u0448\u0435\u043d\u0438\u0439 \u043d\u0435\u0442.";
  }
  if (snapshot.searchStatus === "partial") {
    if (relevanceGate.audit && relevanceGate.audit.checked > 0) {
      return "Поиск GitHub завершён частично: в неполном срезе ни один кандидат не доказал одновременно Telegram + CRM/лиды. Нужен повтор после восстановления источника.";
    }
    return "\u041f\u043e\u0438\u0441\u043a GitHub \u0437\u0430\u0432\u0435\u0440\u0448\u0451\u043d \u0447\u0430\u0441\u0442\u0438\u0447\u043d\u043e: \u0432 \u043d\u0435\u043f\u043e\u043b\u043d\u043e\u043c \u0441\u0440\u0435\u0437\u0435 \u043a\u0430\u043d\u0434\u0438\u0434\u0430\u0442\u043e\u0432 \u043d\u0435\u0442. \u041d\u0443\u0436\u0435\u043d \u043f\u043e\u0432\u0442\u043e\u0440 \u043f\u043e\u0441\u043b\u0435 \u0432\u043e\u0441\u0441\u0442\u0430\u043d\u043e\u0432\u043b\u0435\u043d\u0438\u044f \u0438\u0441\u0442\u043e\u0447\u043d\u0438\u043a\u0430.";
  }
  if (relevanceGate.audit && relevanceGate.audit.checked > 0) {
    return "GitHub вернул кандидатов, но ни один не доказал одновременно Telegram + CRM/лиды по сохранённым metadata/README. LLM ranking не вызывался; отклонённые репозитории не рекомендуются.";
  }
  return "\u0412 \u043f\u043e\u043a\u0440\u044b\u0442\u043e\u043c GitHub-\u0441\u0440\u0435\u0437\u0435 \u043a\u0430\u043d\u0434\u0438\u0434\u0430\u0442\u043e\u0432 \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u043e. YouTube, SaaS \u0438 n8n.io \u043d\u0435 \u0438\u0441\u043a\u0430\u043b\u0438; \u044d\u0442\u043e \u043d\u0435 \u0432\u044b\u0432\u043e\u0434 \u043e \u0432\u0441\u0451\u043c \u0440\u044b\u043d\u043a\u0435.";
}

const NEXT_STEPS = [
  "\u0412\u043b\u0430\u0434\u0435\u043b\u0435\u0446: \u043e\u0442\u043a\u0440\u044b\u0442\u044c \u043a\u0430\u043d\u043e\u043d\u0438\u0447\u0435\u0441\u043a\u0443\u044e GitHub-\u0441\u0441\u044b\u043b\u043a\u0443 \u043b\u0438\u0434\u0435\u0440\u0430 \u0438 \u0441\u0432\u0435\u0440\u0438\u0442\u044c README/\u043b\u0438\u0446\u0435\u043d\u0437\u0438\u044e.",
  "\u0422\u0435\u0445\u043d\u0438\u0447\u0435\u0441\u043a\u0438\u0439 \u043e\u0442\u0432\u0435\u0442\u0441\u0442\u0432\u0435\u043d\u043d\u044b\u0439: \u043f\u0440\u043e\u0432\u0435\u0441\u0442\u0438 \u0440\u0443\u0447\u043d\u043e\u0439 dependency/security review \u0431\u0435\u0437 \u0437\u0430\u043f\u0443\u0441\u043a\u0430 \u043a\u043e\u0434\u0430.",
  "\u0412\u043b\u0430\u0434\u0435\u043b\u0435\u0446: \u043e\u0442\u0434\u0435\u043b\u044c\u043d\u043e \u043e\u0434\u043e\u0431\u0440\u0438\u0442\u044c \u0438\u043b\u0438 \u043e\u0442\u043a\u043b\u043e\u043d\u0438\u0442\u044c \u0438\u0437\u043e\u043b\u0438\u0440\u043e\u0432\u0430\u043d\u043d\u044b\u0439 pilot \u0441 \u043b\u0438\u043c\u0438\u0442\u043e\u043c \u0431\u044e\u0434\u0436\u0435\u0442\u0430.",
] as const;

function noCandidateNextSteps(snapshot: SolutionSearchSnapshot): string[] {
  if (snapshot.searchStatus === "error" || snapshot.searchStatus === "partial") {
    return [
      "\u0412\u043b\u0430\u0434\u0435\u043b\u0435\u0446: \u0434\u043e\u0436\u0434\u0430\u0442\u044c\u0441\u044f \u0432\u043e\u0441\u0441\u0442\u0430\u043d\u043e\u0432\u043b\u0435\u043d\u0438\u044f GitHub/rate limit; \u044d\u0442\u043e\u0442 \u0440\u0435\u0437\u0443\u043b\u044c\u0442\u0430\u0442 \u043d\u0435 \u0441\u0447\u0438\u0442\u0430\u0442\u044c \u0434\u043e\u043a\u0430\u0437\u0430\u0442\u0435\u043b\u044c\u0441\u0442\u0432\u043e\u043c \u043eтсутствия \u0440\u0435\u0448\u0435\u043d\u0438\u0439.",
      "Solution-scout: \u043f\u043e\u0432\u0442\u043e\u0440\u0438\u0442\u044c \u0442\u043e\u0442 \u0436\u0435 bounded GitHub search \u043e\u0442\u0434\u0435\u043b\u044c\u043d\u043e\u0439 \u0437\u0430\u0434\u0430\u0447\u0435\u0439 \u043f\u043e\u0441\u043b\u0435 \u0432\u043e\u0441\u0441\u0442\u0430\u043d\u043e\u0432\u043b\u0435\u043d\u0438\u044f \u0438\u0441\u0442\u043e\u0447\u043d\u0438\u043a\u0430.",
      "\u0412\u043b\u0430\u0434\u0435\u043b\u0435\u0446: \u0442\u043e\u043b\u044c\u043a\u043e \u043f\u043e\u0441\u043b\u0435 retry \u043e\u0442\u0434\u0435\u043b\u044c\u043d\u043e \u043e\u0434\u043e\u0431\u0440\u0438\u0442\u044c \u0440\u0430\u0441\u0448\u0438\u0440\u0435\u043d\u0438\u0435 \u043f\u043e\u043a\u0440\u044b\u0442\u0438\u044f YouTube/SaaS/n8n.io; \u043d\u0438\u0447\u0435\u0433\u043e \u043d\u0435 \u0443\u0441\u0442\u0430\u043d\u0430\u0432\u043b\u0438\u0432\u0430\u0442\u044c.",
    ];
  }
  return [
    "\u0412\u043b\u0430\u0434\u0435\u043b\u0435\u0446: \u0443\u0442\u043e\u0447\u043d\u0438\u0442\u044c \u0444\u043e\u0440\u043c\u0443\u043b\u0438\u0440\u043e\u0432\u043a\u0443 \u0437\u0430\u0434\u0430\u0447\u0438 \u0438 \u043a\u0440\u0438\u0442\u0435\u0440\u0438\u0438 \u0433\u043e\u0442\u043e\u0432\u043e\u0433\u043e \u0440\u0435\u0448\u0435\u043d\u0438\u044f.",
    "Solution-scout: \u043f\u043e\u0432\u0442\u043e\u0440\u0438\u0442\u044c bounded GitHub search \u043d\u043e\u0432\u043e\u0439 \u0437\u0430\u0434\u0430\u0447\u0435\u0439 \u0441 \u0443\u0442\u043e\u0447\u043d\u0451\u043d\u043d\u044b\u043c \u0434\u043e\u043c\u0435\u043d\u043e\u043c.",
    "\u0412\u043b\u0430\u0434\u0435\u043b\u0435\u0446: \u0435\u0441\u043b\u0438 retry \u0441\u043d\u043e\u0432\u0430 \u043f\u0443\u0441\u0442, \u043e\u0442\u0434\u0435\u043b\u044c\u043d\u043e \u043e\u0434\u043e\u0431\u0440\u0438\u0442\u044c \u043f\u043e\u0438\u0441\u043a \u0432 YouTube/SaaS/n8n.io; \u043d\u0438\u0447\u0435\u0433\u043e \u043d\u0435 \u0443\u0441\u0442\u0430\u043d\u0430\u0432\u043b\u0438\u0432\u0430\u0442\u044c.",
  ];
}

function modelFacts(
  result: CallModelResult | null,
  valid: boolean,
  noCandidateReason = "no candidates",
): Record<string, unknown> {
  if (result === null) return { called: false, valid: false, fallback: noCandidateReason };
  return {
    called: true,
    valid,
    fallback: valid ? null : "deterministic",
    ...(result.model !== undefined ? { model: result.model } : {}),
    ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
    ...(result.ledgerWarning !== undefined ? { ledgerWarning: result.ledgerWarning } : {}),
    reason: result.reason.slice(0, 240),
  };
}

/**
 * Bounded, read-only solution-scout orchestration. Snapshot persistence is the
 * trust boundary: a model call can only happen after Core returned stored data.
 */
export async function findSolutions(
  gateway: ModelGateway,
  connector: SolutionSearchGitHubPort,
  input: SolutionSearchInput,
  options: SolutionSearchOptions,
): Promise<Proposal> {
  let stored: SolutionSnapshotRecord;
  if (options.snapshotPort.existing !== undefined && options.snapshotPort.existing !== null) {
    stored = options.snapshotPort.existing;
  } else {
    const gathered = await gatherSnapshot(
      connector,
      input,
      options.now ?? (() => new Date()),
      options.assertLease,
    );
    // Validate locally before sending public JSON to Core; Core performs its
    // own independent 64 KiB/public-data validation as well.
    parseSolutionSnapshot(gathered);
    await options.assertLease?.();
    stored = await options.snapshotPort.save(SOLUTION_SEARCH_SNAPSHOT_KIND, gathered);
  }
  // Never continue from the pre-save object: an idempotent Core save may have
  // returned the immutable snapshot created by a previous worker.
  const snapshot = parseStoredSnapshot(stored);
  const relevanceGate = applyRelevanceGate(input, snapshot.candidates);
  // This derived view is authoritative for every downstream consumer. Raw
  // rejected candidates remain available only in the bounded gate audit; they
  // can never enter the provider prompt, ranking, report or recommendation.
  const rankableSnapshot: SolutionSearchSnapshot = {
    ...snapshot,
    candidates: relevanceGate.candidates,
  };

  let modelResult: CallModelResult | null = null;
  let scores: Map<number, ModelScores> | null = null;
  if (rankableSnapshot.candidates.length > 0) {
    modelResult = await callModel(
      gateway,
      {
        system:
          "\u041e\u0446\u0435\u043d\u0438 \u0442\u043e\u043b\u044c\u043a\u043e readiness, cis, relevance \u043f\u043e 1..5 \u0438 \u0442\u043e\u043b\u044c\u043a\u043e \u043f\u043e evidence. \u041d\u0435\u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0451\u043d\u043d\u044b\u0435 RU/CIS-\u043b\u043e\u043a\u0430\u043b\u0438\u0437\u0430\u0446\u0438\u044e, \u043e\u043f\u043b\u0430\u0442\u0443, \u0445\u043e\u0441\u0442\u0438\u043d\u0433 \u0438 compliance \u0441\u0447\u0438\u0442\u0430\u0439 unknown, \u043d\u0435 \u0444\u0430\u043a\u0442\u043e\u043c. \u0418\u0441\u043f\u043e\u043b\u044c\u0437\u0443\u0439 \u0442\u043e\u043b\u044c\u043a\u043e \u043f\u0435\u0440\u0435\u0434\u0430\u043d\u043d\u044b\u0435 ID; \u043d\u0435 \u043f\u0440\u0438\u0434\u0443\u043c\u044b\u0432\u0430\u0439 \u0444\u0430\u043a\u0442\u044b \u0438 URL.",
        prompt:
          '\u0412\u0435\u0440\u043d\u0438 \u0441\u0442\u0440\u043e\u0433\u043e JSON: {"rankings":[{"id":1,"readiness":1,"cis":1,"relevance":1}]}. \u041f\u043e \u043e\u0434\u043d\u043e\u0439 \u0437\u0430\u043f\u0438\u0441\u0438 \u043d\u0430 \u043a\u0430\u0436\u0434\u044b\u0439 ID.',
        untrustedContext: modelEvidence(input, rankableSnapshot),
        maxTokens: MODEL_MAX_TOKENS,
        reasoningEffort: "none",
        agentName: options.agentName,
        feature: "find-solution:rank",
        requestKey: `${options.requestKey}:rank`,
        traceKey: options.traceKey ?? options.requestKey,
        ...(options.assertLease ? { assertLease: options.assertLease } : {}),
        ...(options.taskLlm ? { taskLlm: options.taskLlm } : {}),
      },
      resolveModelChain(),
    );
    if (modelResult.ok) {
      scores = parseModelScores(
        modelResult.text,
        rankableSnapshot.candidates.map((candidate) => candidate.id),
      );
    }
  }

  const ranked = rankSolutions(rankableSnapshot, scores);
  const report = ownerReport(input, snapshot, ranked, modelResult, scores !== null, relevanceGate);
  const snapshotHash =
    stored.hash !== undefined && /^[0-9a-f]{64}$/.test(stored.hash) ? stored.hash : undefined;
  const action =
    ranked.length === 0
      ? noCandidateAction(snapshot, relevanceGate)
      : `\u041e\u0442\u0440\u0430\u043d\u0436\u0438\u0440\u043e\u0432\u0430\u043d\u043e ${ranked.length} \u043f\u0443\u0431\u043b\u0438\u0447\u043d\u044b\u0445 GitHub-\u0440\u0435\u043f\u043e\u0437\u0438\u0442\u043e\u0440\u0438\u0435\u0432. \u041b\u0438\u0434\u0435\u0440: ${ranked[0].candidate.fullName} (${ranked[0].total}/25). \u042d\u0442\u043e \u0440\u0430\u0437\u0432\u0435\u0434\u043a\u0430 T1; \u043d\u0438\u0447\u0435\u0433\u043e \u043d\u0435 \u0443\u0441\u0442\u0430\u043d\u0430\u0432\u043b\u0438\u0432\u0430\u043b\u043e\u0441\u044c \u0438 \u043d\u0435 \u0437\u0430\u043f\u0443\u0441\u043a\u0430\u043b\u043e\u0441\u044c.`;

  return {
    action: action.slice(0, 512),
    facts: {
      ownerReport: report,
      snapshot: {
        kind: SOLUTION_SEARCH_SNAPSHOT_KIND,
        ...(snapshotHash ? { hash: snapshotHash } : {}),
        retrievedAt: snapshot.retrievedAt,
        queries: snapshot.queries,
        coverageGaps: snapshot.coverageGaps,
        status: snapshot.searchStatus,
      },
      evidence: {
        candidates: ranked.map((item) => ({
          id: item.candidate.id,
          fullName: item.candidate.fullName,
          url: item.candidate.url,
          stars: item.candidate.stars,
          licenseSpdx: item.candidate.licenseSpdx,
          pushedAt: item.candidate.pushedAt,
          readme: {
            status: item.candidate.readme.status,
            ...(item.candidate.readme.status === "error"
              ? { category: item.candidate.readme.category }
              : {}),
          },
          manifests: item.candidate.manifests.map((manifest) => ({
            name: manifest.name,
            status: manifest.status,
            ...(manifest.status === "error" ? { category: manifest.category } : {}),
          })),
          denylisted: item.denylisted,
          scores: {
            readiness: item.readiness,
            cis: item.cis,
            cost: item.cost,
            relevance: item.relevance,
            maintenance: item.maintenance,
            total: item.total,
          },
        })),
        searchIssues: snapshot.searchIssues,
      },
      ...(relevanceGate.audit ? { relevanceGate: relevanceGate.audit } : {}),
      model: modelFacts(
        modelResult,
        scores !== null,
        relevanceGate.audit && relevanceGate.audit.checked > 0
          ? "no relevant candidates"
          : "no candidates",
      ),
    },
    // Дедуп — по НАБОРУ найденных репозиториев (отсортированные url), запросам и
    // статусу поиска. Волатильные retrievedAt (штамп каждой выемки), stars
    // (счётчик звёзд плавает между выемками) и баллы ранжирования LLM в сигнатуру
    // НЕ идут: иначе тот же результат по тому же запросу подавался бы как новый
    // каждый прогон. Набор url меняется ⟺ GitHub вернул другие репозитории
    // (содержательное изменение разведки); сортировка делает ключ независимым от
    // порядка ранжирования. Владельцу facts полные (ownerReport, звёзды, баллы).
    signatureFacts: {
      queries: [...snapshot.queries].sort(),
      status: snapshot.searchStatus,
      candidates: ranked.map((item) => item.candidate.url).sort(),
    },
    next: ranked.length === 0 ? noCandidateNextSteps(snapshot) : [...NEXT_STEPS],
  };
}
