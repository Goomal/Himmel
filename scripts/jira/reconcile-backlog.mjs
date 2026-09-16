#!/usr/bin/env node
// scripts/jira/reconcile-backlog.mjs — HIMMEL-374 pure-code backlog reconciler.
//
// Structural fix for Jira backlog drift (HIMMEL-195 philosophy): classify
// every open ticket against the merged-commit corpus with the deterministic
// rules in reconcile-lib.mjs, then comment+transition. No model calls.
//
// I/O only lives here; reconcile-lib.mjs stays a pure function library so
// the evidence rule is unit-testable against fixtures. This file talks to:
//   - the jira CLI's compiled client (dist/, built via `npm run build`) for
//     reads (issue search, comments) — no CLI verb exists for either, so we
//     import the same request() the CLI commands use rather than duplicate
//     auth/env handling.
//   - the jira CLI itself, as a subprocess, for writes (comment/transition)
//     — that preserves its breadcrumb-writing and attestation conventions
//     instead of bypassing them via a direct API call.
//   - git, for the commit corpus (subject + body per commit on `main`).
//
// Usage:
//   node reconcile-backlog.mjs [--apply] [--project HIMMEL] [--limit 2000]
//     [--config reconcile-config.json] [--hygiene-doc <path>]
//     [--commits-file <path>] [--jira-cli <path-to-dist/index.js>]
//     [--only KEY1,KEY2,...]
//
// Default is --dry-run (no writes). Prints one JSON line per candidate
// ticket to stdout, plus a summary line at the end.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyTicket, findMatches, applyDisposition, buildEvidenceComment } from './reconcile-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const opts = {
    apply: false,
    project: process.env.JIRA_PROJECT_KEY,
    limit: '2000',
    config: join(HERE, 'reconcile-config.json'),
    hygieneDoc: null,
    commitsFile: null,
    jiraCli: join(HERE, 'dist', 'index.js'),
    only: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--dry-run') opts.apply = false;
    else if (a === '--project') opts.project = argv[++i];
    else if (a === '--limit') opts.limit = argv[++i];
    else if (a === '--config') opts.config = argv[++i];
    else if (a === '--hygiene-doc') opts.hygieneDoc = argv[++i];
    else if (a === '--commits-file') opts.commitsFile = argv[++i];
    else if (a === '--jira-cli') opts.jiraCli = argv[++i];
    else if (a === '--only') opts.only = new Set(argv[++i].split(',').map((s) => s.trim()));
    else {
      process.stderr.write(`reconcile-backlog: unknown argument "${a}"\n`);
      process.exit(1);
    }
  }
  if (!opts.project) {
    process.stderr.write('reconcile-backlog: --project or JIRA_PROJECT_KEY is required\n');
    process.exit(1);
  }
  return opts;
}

function loadConfig(path) {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Every key named under ANY table (CLOSED / RESCOPED / STALE-PREMISE /
// LEFT ALONE / decided-but-not-written) of the hygiene-sweep report is
// "already adjudicated" — including the LEFT ALONE rows that carry no Jira
// comment at all (the gap this reconciler must not blindly re-close).
// All of the report's tables share one markdown shape: `| HIMMEL-1234 | ...`.
function loadHygieneKeys(path) {
  if (!path || !existsSync(path)) return new Set();
  const text = readFileSync(path, 'utf8');
  const keys = new Set();
  for (const m of text.matchAll(/^\|\s*([A-Za-z]+-\d+)\s*\|/gm)) keys.add(m[1]);
  return keys;
}

// Prefer an explicit --commits-file (date\tsubject, newest first — the shape
// a prior audit already produced by merging public + archived-private git
// history). Falling back to a live `git log` only covers THIS repo's public
// history: any ticket whose only evidence lives in the archived private
// history will read as no-evidence, not as a false CLOSE — a safe direction
// for a fallback to fail in.
function loadCommits(commitsFile) {
  if (commitsFile) {
    const lines = readFileSync(commitsFile, 'utf8').split('\n').filter(Boolean);
    return lines.map((line) => {
      const [date, ...rest] = line.split('\t');
      return { sha: null, date, subject: rest.join('\t'), body: '' };
    });
  }
  process.stderr.write(
    'reconcile-backlog: no --commits-file given; falling back to `git log` on this repo only ' +
      '(archived private history, if any, will not be searched).\n',
  );
  const out = execFileSync(
    'git',
    ['-C', HERE, 'log', '--first-parent', 'main', '--format=%H%x09%ad%x09%s', '--date=short'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, date, ...rest] = line.split('\t');
      return { sha, date, subject: rest.join('\t'), body: '' };
    });
}

async function loadBacklog({ jiraCli, project, limit }) {
  const distDir = dirname(jiraCli);
  const { searchAllIssues } = await import(join(distDir, 'commands', 'list.js'));
  const { request } = await import(join(distDir, 'client.js'));
  const jql = `project=${project} AND status in ("To Do","In Progress","In Review") ORDER BY created ASC`;
  const issues = await searchAllIssues(jql, limit, request);
  return issues.map((issue) => ({
    key: issue.key,
    issueType: issue.fields.issuetype.name,
    status: issue.fields.status.name,
  }));
}

async function loadCommentBodies({ jiraCli, key }) {
  const distDir = dirname(jiraCli);
  const { request } = await import(join(distDir, 'client.js'));
  const { adfToPlainText } = await import(join(distDir, 'adf-render.js'));
  const result = await request('GET', `/issue/${key}/comment`);
  return (result.comments ?? []).map((c) => adfToPlainText(c.body) ?? '');
}

async function loadDescription({ jiraCli, key }) {
  const distDir = dirname(jiraCli);
  const { request } = await import(join(distDir, 'client.js'));
  const { adfToPlainText } = await import(join(distDir, 'adf-render.js'));
  const issue = await request('GET', `/issue/${key}?fields=description`);
  return adfToPlainText(issue.fields?.description) ?? '';
}

function makeJiraClient(jiraCliPath) {
  return {
    async comment(key, body) {
      const tmpDir = mkdtempSync(join(tmpdir(), 'himmel-reconcile-'));
      const tmpFile = join(tmpDir, `${key}-comment.md`);
      writeFileSync(tmpFile, body);
      try {
        execFileSync('node', [jiraCliPath, 'comment', key, '--comment-file', tmpFile], {
          encoding: 'utf8',
        });
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    async transition(key, status) {
      execFileSync('node', [jiraCliPath, 'transition', key, status], { encoding: 'utf8' });
    },
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const config = loadConfig(opts.config);
  const projectConfig = config[opts.project];
  const targetStatus = projectConfig?.targetStatus;

  const hygieneKeys = loadHygieneKeys(opts.hygieneDoc);
  const commits = loadCommits(opts.commitsFile);
  const backlog = await loadBacklog({ jiraCli: opts.jiraCli, project: opts.project, limit: opts.limit });

  const jiraClient = makeJiraClient(opts.jiraCli);

  const counts = { CLOSE: 0, RESCOPE: 0, 'STALE-PREMISE': 0, LEAVE: 0 };
  const acted = [];

  for (const ticket of backlog) {
    if (opts.only && !opts.only.has(ticket.key)) continue;

    const { subjectCommits, bodyOnlyCommits } = findMatches(commits, ticket.key);

    // Fetch comments only when there is evidence to act on — the tool's own
    // marker can only ever exist on a ticket it previously found evidence
    // for, so a zero-evidence ticket cannot carry it. Keeps the real run
    // bounded to the candidate set instead of a comment-fetch per all ~989
    // open tickets.
    const hasEvidence = subjectCommits.length > 0 || bodyOnlyCommits.length > 0;
    const commentBodies = hasEvidence ? await loadCommentBodies({ jiraCli: opts.jiraCli, key: ticket.key }) : [];
    const description = hasEvidence ? await loadDescription({ jiraCli: opts.jiraCli, key: ticket.key }) : '';

    const result = classifyTicket({
      key: ticket.key,
      issueType: ticket.issueType,
      status: ticket.status,
      targetStatus,
      commentBodies,
      hygieneKeys,
      subjectCommits,
      bodyOnlyCommits,
      description,
    });

    counts[result.disposition] = (counts[result.disposition] ?? 0) + 1;

    const record = {
      key: ticket.key,
      issueType: ticket.issueType,
      status: ticket.status,
      disposition: result.disposition,
      reason: result.reason,
      evidence: result.evidence ? { sha: result.evidence.sha, date: result.evidence.date, subject: result.evidence.subject } : null,
    };
    console.log(JSON.stringify(record));

    if (result.disposition === 'LEAVE') continue;

    acted.push(record);
    if (opts.apply) {
      const commentBody = buildEvidenceComment({ key: ticket.key, ...result });
      const applied = await applyDisposition({
        key: ticket.key,
        disposition: result.disposition,
        targetStatus,
        commentBody,
        jiraClient,
      });
      record.applied = applied.action;
    }
  }

  console.log(
    JSON.stringify({
      summary: true,
      mode: opts.apply ? 'apply' : 'dry-run',
      total: backlog.length,
      counts,
      acted: acted.length,
    }),
  );
}

main().catch((err) => {
  process.stderr.write(`reconcile-backlog: ${err.stack ?? err.message}\n`);
  process.exit(1);
});
