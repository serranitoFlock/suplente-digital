import { describe, expect, it } from "vitest";
import { findWriteOperations, guardScript } from "../src/tools/script-guard.js";

const root = process.cwd();
const families = (text: string, shell = true) => findWriteOperations(text, { shell }).map((finding) => finding.family);

describe("static write guard (reject-only heuristic)", () => {
  it.each([
    ["curl -s -X POST https://ci.example.com/api/jobs/1/retry", "http-write"],
    ["curl --request PUT https://example.com/x", "http-write"],
    ["curl -X=DELETE https://example.com/x", "http-write"],
    ["gh api --method PATCH repos/acme/x", "http-write"],
    // The verb must be a literal GET/HEAD: anything built at runtime counts as a write.
    ['M=PO; M="${M}ST"; curl -s --request "$M" https://ci.example.com/api/jobs/1/retry', "http-write"],
    ["curl -X $VERB https://example.com/x", "http-write"],
    ["curl -d 'a=1' https://example.com/x", "http-body-upload"],
    ["curl -sd 'a=1' https://example.com/x", "http-body-upload"],
    ["curl --data-binary @file https://example.com/x", "http-body-upload"],
    ["curl -F file=@a.txt https://example.com/x", "http-body-upload"],
    ["curl --form a=1 https://example.com/x", "http-body-upload"],
    ["curl -T a.txt https://example.com/x", "http-body-upload"],
    ["wget --post-data 'a=1' https://example.com/x", "http-body-upload"],
    ['await fetch(url, { method: "POST", body })', "http-client-write"],
    ["fetch(url, {method:'delete'})", "http-client-write"],
    ["requests.post(url, json=payload)", "http-client-write"],
    ["axios.delete(`${base}/jobs/1`)", "http-client-write"],
    ['requests.request("PUT", url)', "http-client-write"],
    ["git push origin main", "git-write"],
    ["git -C repo commit -m wip", "git-write"],
    ["git merge feature", "git-write"],
    ["git rebase main", "git-write"],
    ["git reset --hard HEAD~1", "git-write"],
    ["git tag v1.0.0", "git-write"],
    ["rm -rf build", "file-delete-move"],
    ["mv a.txt b.txt", "file-delete-move"],
    ["touch marker", "file-delete-move"],
    ["fs.writeFileSync('out.json', data)", "file-write-api"],
    ["open('report.txt', 'w')", "file-write-api"],
    ["echo hi > out.txt", "shell-redirect"],
    ["echo hi >> log.txt", "shell-redirect"],
    ["jq . 1>result.json", "shell-redirect"],
    ["glab ci retry 123", "cli-mutation"],
    ["gh run cancel 42", "cli-mutation"],
    ["gh pr merge 7", "cli-mutation"],
    ["glab mr approve 7", "cli-mutation"],
    ["gh issue close 3", "cli-mutation"],
    ["glab ci run --branch main", "cli-mutation"],
    ["gh api -f state=closed repos/acme/x", "cli-mutation"],
    ["npm publish --access public", "package-publish"],
    ["kubectl apply -f deploy.yaml", "cluster-write"],
    ["kubectl -n prod delete pod web-1", "cluster-write"],
    ["sed -i 's/a/b/' file.txt", "in-place-edit"],
    ["sed -E -i.bak 's/a/b/' file.txt", "in-place-edit"],
    ["echo hi | tee out.txt", "in-place-edit"],
  ])("rejects %j (%s)", (text, family) => {
    expect(families(text)).toContain(family);
  });

  it.each([
    'echo "error" >&2',
    "command -v jq 2>/dev/null",
    "ls missing >/dev/null 2>&1",
    "curl -s https://ci.example.com/api/v4/projects/1/jobs?scope=failed",
    "curl -fsSL -H 'Accept: application/json' https://example.com/x",
    "git log --oneline -5",
    "glab ci list --status failed",
    "gh run list --status failure",
    "kubectl get pods",
    "sed -n '1,5p' file.txt",
    'fetch(url, { method: "GET" })',
    "curl -s -X GET https://ci.example.com/api/jobs",
    "curl --request=HEAD https://ci.example.com/api/jobs",
    "curl -I https://ci.example.com/api/jobs",
    "requests.get(url)",
  ])("accepts read-only %j", (text) => {
    expect(families(text)).toEqual([]);
  });

  it("only checks shell redirection in shell text (arrow functions and comparisons are not redirections)", () => {
    expect(families("const ok = items.filter((x) => x.size > 5);", false)).toEqual([]);
    expect(families("echo hi > out.txt", false)).toEqual([]);
  });

  it("accepts the demo script and scans the file a command points to", async () => {
    expect(await guardScript({ command: "scripts/demo/failed-jobs.sh", argv: ["--days", "{days}"] }, root)).toEqual([]);
    const findings = await guardScript({ command: "tests/fixtures/scripts/retry-job.sh", argv: ["{job}"] }, root);
    expect(findings.map((f) => f.family)).toContain("http-write");
    expect(findings[0]!.source).toBe("tests/fixtures/scripts/retry-job.sh");
  });

  it("scans argv literals and files they point to, ignoring placeholders", async () => {
    expect((await guardScript({ command: "git", argv: ["push", "{remote}"] }, root)).map((f) => f.family)).toContain("git-write");
    const viaInterpreter = await guardScript({ command: "sh", argv: ["tests/fixtures/scripts/retry-job.sh"] }, root);
    expect(viaInterpreter.map((f) => f.source)).toContain("tests/fixtures/scripts/retry-job.sh");
    expect(await guardScript({ command: "glab", argv: ["ci", "list", "--status", "{status}"] }, root)).toEqual([]);
  });
});
