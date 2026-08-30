import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GITHUB_CONNECTOR_LIMITS,
  GitHubConnector,
  GitHubConnectorError,
  type GitHubConnectorConfig,
  type GitHubManifestName,
} from "./github";

const REPOSITORY = {
  id: 42,
  name: "useful-ai",
  full_name: "octocat/useful-ai",
  html_url: "https://attacker.invalid/not-the-repository",
  description: "A useful project",
  stargazers_count: 1_234,
  forks_count: 56,
  archived: false,
  language: "TypeScript",
  topics: ["ai", "automation"],
  license: { spdx_id: "MIT" },
  default_branch: "release/v2",
  pushed_at: "2026-08-29T12:00:00Z",
  updated_at: "2026-08-30T12:00:00Z",
};

const SEARCH_RESPONSE = {
  total_count: 1,
  incomplete_results: false,
  items: [REPOSITORY],
};

const SHA = "0123456789abcdef0123456789abcdef01234567";

function jsonResponse(
  value: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

function readmeResponse(text: string, overrides: Record<string, unknown> = {}): Response {
  const encoded = Buffer.from(text, "utf8").toString("base64");
  const wrapped = encoded.length > 8 ? `${encoded.slice(0, 8)}\n${encoded.slice(8)}\n` : encoded;
  return jsonResponse({
    type: "file",
    encoding: "base64",
    name: "README.md",
    path: "README.md",
    sha: SHA,
    size: Buffer.byteLength(text),
    content: wrapped,
    html_url: "https://attacker.invalid/readme",
    download_url: "https://attacker.invalid/raw",
    ...overrides,
  });
}

function assertConnectorError(
  error: unknown,
  code: GitHubConnectorError["code"],
  status?: number,
): boolean {
  assert.ok(error instanceof GitHubConnectorError);
  assert.equal(error.code, code);
  assert.equal(error.status, status);
  return true;
}

describe("GitHubConnector", () => {
  it("search uses only fixed GitHub API, bounded GET and reconstructs canonical URL", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const token = "github-secret-token";
    const reset = Date.UTC(2030, 0, 1) / 1_000;
    const connector = new GitHubConnector({
      token,
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), init });
        return jsonResponse(SEARCH_RESPONSE, {
          headers: {
            "X-RateLimit-Limit": "30",
            "X-RateLimit-Remaining": "29",
            "X-RateLimit-Used": "1",
            "X-RateLimit-Reset": String(reset),
            "X-RateLimit-Resource": "search",
          },
        });
      },
    });

    const result = await connector.searchRepositories("  topic:ai stars:>100  ", { items: 2 });

    assert.equal(calls.length, 1);
    const url = new URL(calls[0]!.url);
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(url.pathname, "/search/repositories");
    assert.equal(url.searchParams.get("q"), "topic:ai stars:>100");
    assert.equal(url.searchParams.get("per_page"), "2");
    assert.equal(url.searchParams.get("page"), "1");
    assert.equal(calls[0]!.init?.method, "GET");
    assert.equal(calls[0]!.init?.redirect, "error");
    assert.ok(calls[0]!.init?.signal instanceof AbortSignal);
    const headers = new Headers(calls[0]!.init?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${token}`);
    assert.equal(headers.get("accept"), "application/vnd.github+json");
    assert.equal(headers.get("x-github-api-version"), "2026-03-10");

    assert.equal(result.items.length, 1);
    assert.deepEqual(result.items[0], {
      id: 42,
      owner: "octocat",
      name: "useful-ai",
      fullName: "octocat/useful-ai",
      url: "https://github.com/octocat/useful-ai",
      description: "A useful project",
      stars: 1_234,
      forks: 56,
      archived: false,
      language: "TypeScript",
      topics: ["ai", "automation"],
      licenseSpdx: "MIT",
      defaultBranch: "release/v2",
      pushedAt: "2026-08-29T12:00:00.000Z",
      updatedAt: "2026-08-30T12:00:00.000Z",
    });
    assert.deepEqual(result.rateLimit, {
      limit: 30,
      remaining: 29,
      used: 1,
      resetAt: "2030-01-01T00:00:00.000Z",
      resource: "search",
    });
    assert.doesNotMatch(JSON.stringify(result), /attacker\.invalid/);
  });

  it("README uses one fixed endpoint, no auth when token is absent, and decodes bounded UTF-8", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const connector = new GitHubConnector({
      fetchImpl: async (input, init) => {
        calls.push({
          url: String(input),
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return readmeResponse("# Install\n\npnpm install");
      },
    });

    const result = await connector.getReadme("octocat", "useful-ai");

    assert.deepEqual(calls, [
      {
        url: "https://api.github.com/repos/octocat/useful-ai/readme",
        authorization: null,
      },
    ]);
    assert.equal(result.fullName, "octocat/useful-ai");
    assert.equal(result.url, "https://github.com/octocat/useful-ai");
    assert.equal(result.text, "# Install\n\npnpm install");
    assert.equal(result.bytes, Buffer.byteLength(result.text));
    assert.equal(result.sha, SHA);
  });

  it("fetchManifest permits only three top-level manifests and types 404 as absence", async () => {
    const urls: string[] = [];
    let calls = 0;
    const connector = new GitHubConnector({
      fetchImpl: async (input) => {
        calls += 1;
        urls.push(String(input));
        if (calls === 1) {
          return readmeResponse('{"dependencies":{"x":"1"}}', {
            name: "package.json",
            path: "package.json",
          });
        }
        return jsonResponse(
          { message: "secret provider body must be ignored" },
          {
            status: 404,
            headers: { "X-RateLimit-Remaining": "27", "X-RateLimit-Resource": "core" },
          },
        );
      },
    });

    const found = await connector.fetchManifest("octocat", "useful-ai", "package.json");
    assert.equal(found.found, true);
    if (found.found) {
      assert.equal(found.evidence.manifest, "package.json");
      assert.equal(found.evidence.text, '{"dependencies":{"x":"1"}}');
      assert.equal(found.evidence.url, "https://github.com/octocat/useful-ai");
    }

    const absent = await connector.fetchManifest("octocat", "useful-ai", "requirements.txt");
    assert.equal(absent.found, false);
    if (!absent.found) {
      assert.equal(absent.manifest, "requirements.txt");
      assert.deepEqual(absent.rateLimit, { remaining: 27, resource: "core" });
    }
    assert.deepEqual(urls, [
      "https://api.github.com/repos/octocat/useful-ai/contents/package.json",
      "https://api.github.com/repos/octocat/useful-ai/contents/requirements.txt",
    ]);

    await assert.rejects(
      () =>
        connector.fetchManifest(
          "octocat",
          "useful-ai",
          "../../secrets" as unknown as GitHubManifestName,
        ),
      (error: unknown) => assertConnectorError(error, "invalid_input"),
    );
    assert.equal(calls, 2, "invalid manifest must fail before fetch");
  });

  it("rejects query, item, timeout and byte bounds before network", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return jsonResponse(SEARCH_RESPONSE);
    };
    const connector = new GitHubConnector({ fetchImpl });
    for (const query of [
      "",
      "x".repeat(GITHUB_CONNECTOR_LIMITS.maxQueryChars + 1),
      "topic:ai\nAuthorization: secret",
    ]) {
      await assert.rejects(
        () => connector.searchRepositories(query),
        (error: unknown) => assertConnectorError(error, "invalid_input"),
      );
    }
    for (const items of [0, 1.5, GITHUB_CONNECTOR_LIMITS.maxItems + 1]) {
      await assert.rejects(
        () => connector.searchRepositories("topic:ai", { items }),
        (error: unknown) => assertConnectorError(error, "invalid_input"),
      );
    }
    assert.equal(calls, 0);

    const invalidConfigs: GitHubConnectorConfig[] = [
      { timeoutMs: GITHUB_CONNECTOR_LIMITS.minTimeoutMs - 1 },
      { timeoutMs: GITHUB_CONNECTOR_LIMITS.maxTimeoutMs + 1 },
      { timeoutMs: 100.5 },
      { maxResponseBytes: 0 },
      { maxResponseBytes: GITHUB_CONNECTOR_LIMITS.maxResponseBytes + 1 },
      { maxReadmeBytes: 0 },
      { maxReadmeBytes: GITHUB_CONNECTOR_LIMITS.maxReadmeBytes + 1 },
    ];
    for (const config of invalidConfigs) {
      assert.throws(
        () => new GitHubConnector({ ...config, fetchImpl }),
        (error: unknown) => assertConnectorError(error, "invalid_input"),
      );
    }
  });

  it("rejects owner/repository path injection before fetch", async () => {
    let calls = 0;
    const connector = new GitHubConnector({
      fetchImpl: async () => {
        calls += 1;
        return readmeResponse("x");
      },
    });
    const samples: Array<[string, string]> = [
      ["../octocat", "repo"],
      ["octocat", "repo/name"],
      ["https://evil.invalid", "repo"],
      ["octocat", ".."],
    ];
    for (const [owner, repository] of samples) {
      await assert.rejects(
        () => connector.getReadme(owner, repository),
        (error: unknown) => assertConnectorError(error, "invalid_input"),
      );
    }
    assert.equal(calls, 0);
  });

  it("rejects malformed search shapes and untrusted full_name instead of emitting their URL", async () => {
    const responses = [
      { ...SEARCH_RESPONSE, items: [{ ...REPOSITORY, full_name: "octocat/repo/extra" }] },
      { ...SEARCH_RESPONSE, items: [{ ...REPOSITORY, full_name: "evil host/repo" }] },
      { ...SEARCH_RESPONSE, items: [{ ...REPOSITORY, name: "other-name" }] },
      { ...SEARCH_RESPONSE, items: [REPOSITORY, REPOSITORY] },
    ];

    for (const body of responses) {
      const connector = new GitHubConnector({ fetchImpl: async () => jsonResponse(body) });
      await assert.rejects(
        () => connector.searchRepositories("topic:ai", { items: 1 }),
        (error: unknown) => assertConnectorError(error, "invalid_response", 200),
      );
    }
  });

  it("enforces response and decoded README byte ceilings", async () => {
    let oversizedCalls = 0;
    const oversized = new GitHubConnector({
      maxResponseBytes: 100,
      fetchImpl: async () => {
        oversizedCalls += 1;
        return new Response("x".repeat(101), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    await assert.rejects(
      () => oversized.searchRepositories("topic:ai"),
      (error: unknown) => assertConnectorError(error, "response_too_large", 200),
    );
    assert.equal(oversizedCalls, 1);

    const readme = new GitHubConnector({
      maxReadmeBytes: 4,
      fetchImpl: async () => readmeResponse("12345"),
    });
    await assert.rejects(
      () => readme.getReadme("octocat", "repo"),
      (error: unknown) => assertConnectorError(error, "response_too_large", 200),
    );
  });

  it("rejects invalid JSON, base64 and size mismatch without retry", async () => {
    const responses = [
      new Response("not json", {
        status: 200,
        headers: { "Content-Type": "application/vnd.github+json; charset=utf-8" },
      }),
      jsonResponse({
        type: "file",
        encoding: "base64",
        name: "README.md",
        path: "README.md",
        sha: SHA,
        size: 3,
        content: "not base64!",
      }),
      readmeResponse("hello", { size: 4 }),
    ];

    for (const response of responses) {
      let calls = 0;
      const connector = new GitHubConnector({
        fetchImpl: async () => {
          calls += 1;
          return response;
        },
      });
      await assert.rejects(
        () => connector.getReadme("octocat", "repo"),
        (error: unknown) => assertConnectorError(error, "invalid_response", 200),
      );
      assert.equal(calls, 1);
    }
  });

  it("rejects non-JSON Content-Type before parsing a successful response", async () => {
    const responses = [
      new Response("<html>provider error</html>", {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
      new Response(Uint8Array.from([0, 1, 2, 3]), {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      }),
    ];

    for (const response of responses) {
      let calls = 0;
      const connector = new GitHubConnector({
        fetchImpl: async () => {
          calls += 1;
          return response;
        },
      });
      await assert.rejects(
        () => connector.searchRepositories("topic:ai"),
        (error: unknown) => assertConnectorError(error, "invalid_response", 200),
      );
      assert.equal(calls, 1);
    }
  });

  it("network and HTTP errors are safe, carry rate-limit evidence and never retry", async () => {
    const token = "do-not-leak-token";
    const transportSecret = "transport-echoed-secret";
    let networkCalls = 0;
    const network = new GitHubConnector({
      token,
      fetchImpl: async () => {
        networkCalls += 1;
        throw new Error(`${transportSecret} ${token}`);
      },
    });
    await assert.rejects(
      () => network.searchRepositories("topic:ai"),
      (error: unknown) => {
        assertConnectorError(error, "network_error");
        assert.ok(error instanceof GitHubConnectorError);
        assert.doesNotMatch(error.message, new RegExp(token));
        assert.doesNotMatch(error.message, new RegExp(transportSecret));
        assert.equal(error.cause, undefined);
        return true;
      },
    );
    assert.equal(networkCalls, 1);

    let rateCalls = 0;
    const rateLimited = new GitHubConnector({
      token,
      fetchImpl: async () => {
        rateCalls += 1;
        return jsonResponse(
          { message: `provider-body-secret ${token}` },
          {
            status: 403,
            headers: {
              "X-RateLimit-Limit": "10",
              "X-RateLimit-Remaining": "0",
              "X-RateLimit-Used": "10",
              "X-RateLimit-Resource": "search",
              "Retry-After": "2",
            },
          },
        );
      },
    });
    await assert.rejects(
      () => rateLimited.searchRepositories("topic:ai"),
      (error: unknown) => {
        assertConnectorError(error, "rate_limited", 403);
        assert.ok(error instanceof GitHubConnectorError);
        assert.deepEqual(error.rateLimit, {
          limit: 10,
          remaining: 0,
          used: 10,
          resource: "search",
          retryAfterMs: 2_000,
        });
        assert.doesNotMatch(error.message, new RegExp(token));
        assert.doesNotMatch(error.message, /provider-body-secret/);
        return true;
      },
    );
    assert.equal(rateCalls, 1);

    for (const remaining of [undefined, "7"] as const) {
      let secondaryCalls = 0;
      const secondaryRateLimit = new GitHubConnector({
        fetchImpl: async () => {
          secondaryCalls += 1;
          return jsonResponse(
            { message: "secondary limit body must not escape" },
            {
              status: 403,
              headers: {
                "Retry-After": "3",
                ...(remaining === undefined ? {} : { "X-RateLimit-Remaining": remaining }),
              },
            },
          );
        },
      });
      await assert.rejects(
        () => secondaryRateLimit.searchRepositories("topic:ai"),
        (error: unknown) => {
          assertConnectorError(error, "rate_limited", 403);
          assert.ok(error instanceof GitHubConnectorError);
          assert.equal(error.rateLimit.retryAfterMs, 3_000);
          assert.doesNotMatch(error.message, /secondary limit body/);
          return true;
        },
      );
      assert.equal(secondaryCalls, 1);
    }

    let serverCalls = 0;
    const serverError = new GitHubConnector({
      fetchImpl: async () => {
        serverCalls += 1;
        return new Response("upstream secret", { status: 500 });
      },
    });
    await assert.rejects(
      () => serverError.searchRepositories("topic:ai"),
      (error: unknown) => assertConnectorError(error, "http_error", 500),
    );
    assert.equal(serverCalls, 1);
  });
});
