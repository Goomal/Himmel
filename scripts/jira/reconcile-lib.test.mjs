import { describe, it, expect } from 'vitest';
import {
  ticketKeyPattern,
  hasBracketedTag,
  isRevertSubject,
  isPartialDelivery,
  hasSkipMarker,
  hasHygieneSweepDisposition,
  hasOutcomeAcceptance,
  findMatches,
  classifyTicket,
  applyDisposition,
  buildEvidenceComment,
  TOOL_EVIDENCE_MARKER,
} from './reconcile-lib.mjs';

// Real HIMMEL-2875 description (fetched 2026-09-16): closed on a merged
// commit that delivered only the leg-owned prep (content audit + Pages
// config); the ticket's acceptance criterion is the live URL, and enabling
// Pages is an operator-only repo setting the description reserves
// explicitly. Reopened after `curl -sI` on the URL came back 404. The
// known-positive fixture for the outcome-acceptance rule.
const HIMMEL_2875_DESCRIPTION = `Operator 2026-09-09 (console 03F): "we can publish the user-facing adoption trail."
What exists
- docs/adoption-trail.html — the user-facing adoption trail page, already in the tree of the (now public) yotamleo/Himmel repo, so its SOURCE is public since the HIMMEL-2705 cutover.
- The same page is published as a private claude.ai artifact ("Himmel Adoption Trail", b13de5c0-...), owned by the operator.
Ask — give it a public URL
Preferred: GitHub Pages from the public repo, source = main / docs/ (or a gh-pages deploy workflow if docs/ must stay a plain folder). Then https://yotamleo.github.io/Himmel/adoption-trail.html is the URL, and every merge to main updates it — no second copy to keep in sync. Enabling Pages is a repo setting = operator action (gh api -X POST repos/yotamleo/Himmel/pages -f build_type=legacy -f source[branch]=main -f source[path]=/docs, or the Settings -> Pages UI); the leg prepares and verifies, the operator flips it.
Verification
curl -sI https://yotamleo.github.io/Himmel/adoption-trail.html -> 200 after the operator enables Pages; the page renders in light/dark; no private-era string survives (git grep the audit list against docs/).`;

function commit(subject, { body = '', sha = 'deadbee', date = '2026-09-01' } = {}) {
  return { sha, date, subject, body };
}

describe('ticketKeyPattern / word-boundary matching', () => {
  it('matches a bare mention with word boundaries', () => {
    expect(ticketKeyPattern('HIMMEL-374').test('fix: HIMMEL-374 thing')).toBe(true);
  });
  it('does not match a longer key sharing a numeric prefix', () => {
    expect(ticketKeyPattern('HIMMEL-374').test('fix: HIMMEL-3745 thing')).toBe(false);
  });
  it('matches inside brackets', () => {
    expect(ticketKeyPattern('HIMMEL-374').test('fix: [HIMMEL-374] thing')).toBe(true);
  });
});

describe('hasBracketedTag', () => {
  it('is true for [KEY] form', () => {
    expect(hasBracketedTag('fix: [HIMMEL-374] thing', 'HIMMEL-374')).toBe(true);
  });
  it('is false for a bare mention with no brackets', () => {
    expect(hasBracketedTag('fix: port HIMMEL-1833 lane figures', 'HIMMEL-1833')).toBe(false);
  });
});

describe('isRevertSubject', () => {
  it('flags a revert: prefix', () => {
    expect(isRevertSubject('revert: [HIMMEL-2148] drop codex plugin fork-pin')).toBe(true);
  });
  it('does not flag a normal fix', () => {
    expect(isRevertSubject('fix: [HIMMEL-374] thing')).toBe(false);
  });
});

describe('isPartialDelivery', () => {
  it.each([
    'fix(upstreams): [HIMMEL-2426] bucket the watch report (PR 1 of 2 — core)',
    'fix(uninstall): [HIMMEL-2854] [5/8] skips repo-hook teardown',
    'docs(externalization): [HIMMEL-2176] Stage-1 PR-D — docs sync',
    'feat(install): [HIMMEL-2326] manifest coverage (manifest half)',
  ])('flags partial-delivery marker in %s', (subject) => {
    expect(isPartialDelivery(subject)).toBe(true);
  });

  it('does not flag a plain complete-looking subject', () => {
    expect(isPartialDelivery('fix: [HIMMEL-374] ship the reconciler')).toBe(false);
  });
});

describe('hasSkipMarker', () => {
  it('detects the hygiene sweep marker', () => {
    expect(hasSkipMarker(['Closed by backlog-hygiene sweep 2026-09-16 — evidence: ...'])).toBe(true);
  });
  it('detects this tool\'s own marker', () => {
    expect(hasSkipMarker([`${TOOL_EVIDENCE_MARKER}\n\nDisposition: CLOSE`])).toBe(true);
  });
  it('is false with unrelated comments', () => {
    expect(hasSkipMarker(['just a normal comment'])).toBe(false);
  });
});

describe('hasHygieneSweepDisposition — the already-adjudicated-without-a-comment gap', () => {
  const hygieneKeys = new Set(['HIMMEL-559', 'HIMMEL-1730', 'HIMMEL-1833', 'HIMMEL-1887', 'HIMMEL-2009', 'HIMMEL-2581']);

  it('is true for a LEFT ALONE / evidence-mismatch key with no Jira comment at all', () => {
    expect(hasHygieneSweepDisposition('HIMMEL-559', hygieneKeys)).toBe(true);
  });
  it('is false for a key the hygiene sweep never touched', () => {
    expect(hasHygieneSweepDisposition('HIMMEL-9999', hygieneKeys)).toBe(false);
  });
  it('is false with no hygiene key set supplied', () => {
    expect(hasHygieneSweepDisposition('HIMMEL-559', undefined)).toBe(false);
  });
});

describe('hasOutcomeAcceptance — a commit proves leg scope, not ticket acceptance', () => {
  it('is true for HIMMEL-2875\'s real description (known-positive: operator-gated Pages URL)', () => {
    expect(hasOutcomeAcceptance(HIMMEL_2875_DESCRIPTION)).toBe(true);
  });

  it('is false for a description that only mentions a URL in passing (known-negative)', () => {
    const description = `See https://github.io/example for background on the format we're adopting.
This ticket is just about renaming the internal config field to match it.`;
    expect(hasOutcomeAcceptance(description)).toBe(false);
  });
});

describe('classifyTicket — outcome-acceptance downgrades CLOSE to RESCOPE, never blocks RESCOPE/LEAVE', () => {
  const base = {
    key: 'HIMMEL-2875',
    issueType: 'Task',
    status: 'In Review',
    targetStatus: 'Done',
    commentBodies: [],
    hygieneKeys: new Set(),
  };

  it('rescopes a clean subject-match when the description gates acceptance on an external outcome', () => {
    const result = classifyTicket({
      ...base,
      subjectCommits: [commit('docs: [HIMMEL-2875] adoption trail — private-era content audit, Pages config and public URL links', { sha: 'e600' })],
      bodyOnlyCommits: [],
      description: HIMMEL_2875_DESCRIPTION,
    });
    expect(result.disposition).toBe('RESCOPE');
    expect(result.reason).toBe('outcome-acceptance');
  });

  it('still closes a clean subject-match when the description does not gate on an external outcome', () => {
    const result = classifyTicket({
      ...base,
      subjectCommits: [commit('fix: [HIMMEL-2875] ship the thing', { sha: 'e601' })],
      bodyOnlyCommits: [],
      description: 'Just fix the bug described above, no external dependency.',
    });
    expect(result.disposition).toBe('CLOSE');
  });

  it('does not override a revert (LEAVE) even with an outcome-acceptance description', () => {
    const result = classifyTicket({
      ...base,
      subjectCommits: [commit('revert: [HIMMEL-2875] drop the thing')],
      bodyOnlyCommits: [],
      description: HIMMEL_2875_DESCRIPTION,
    });
    expect(result.disposition).toBe('LEAVE');
    expect(result.reason).toBe('revert');
  });
});

describe('buildEvidenceComment — outcome-acceptance names the unverified external outcome', () => {
  it('includes the detail line for outcome-acceptance', () => {
    const text = buildEvidenceComment({
      key: 'HIMMEL-2875',
      disposition: 'RESCOPE',
      reason: 'outcome-acceptance',
      evidence: commit('docs: [HIMMEL-2875] adoption trail prep'),
      detail: 'curl -sI https://yotamleo.github.io/Himmel/adoption-trail.html -> 200 after the operator enables Pages',
    });
    expect(text).toContain('Unverified external outcome');
    expect(text).toContain('yotamleo.github.io');
  });
});

describe('findMatches', () => {
  it('separates subject matches from body-only matches, newest first preserved', () => {
    const commits = [
      commit('fix: [HIMMEL-374] ship the reconciler', { sha: 'aaa', date: '2026-09-16' }),
      commit('chore: unrelated', { body: 'touches HIMMEL-374 in passing', sha: 'bbb', date: '2026-09-10' }),
    ];
    const { subjectCommits, bodyOnlyCommits } = findMatches(commits, 'HIMMEL-374');
    expect(subjectCommits.map((c) => c.sha)).toEqual(['aaa']);
    expect(bodyOnlyCommits.map((c) => c.sha)).toEqual(['bbb']);
  });

  it('demotes a cross-reference (bare mention inside a commit bracketed for a different ticket) to body-only', () => {
    const commits = [
      commit('fix: [HIMMEL-1887] roll the CLIProxyAPI pin + port the unmerged HIMMEL-1833 lane figures', {
        sha: 'ccc',
        date: '2026-08-17',
      }),
    ];
    const { subjectCommits, bodyOnlyCommits } = findMatches(commits, 'HIMMEL-1833');
    expect(subjectCommits).toEqual([]);
    expect(bodyOnlyCommits.map((c) => c.sha)).toEqual(['ccc']);
  });

  it('keeps a bracketed-tag match as a full subject match', () => {
    const commits = [commit('fix: [HIMMEL-1887] roll the CLIProxyAPI pin', { sha: 'ddd' })];
    const { subjectCommits } = findMatches(commits, 'HIMMEL-1887');
    expect(subjectCommits.map((c) => c.sha)).toEqual(['ddd']);
  });
});

describe('classifyTicket', () => {
  const base = {
    key: 'HIMMEL-9001',
    issueType: 'Task',
    status: 'Open',
    targetStatus: 'Done',
    commentBodies: [],
    hygieneKeys: new Set(),
    subjectCommits: [],
    bodyOnlyCommits: [],
  };

  it('leaves Epics alone', () => {
    expect(classifyTicket({ ...base, issueType: 'Epic', subjectCommits: [commit('fix: [HIMMEL-9001] x')] }))
      .toMatchObject({ disposition: 'LEAVE', reason: 'epic-or-story' });
  });

  it('leaves Stories alone', () => {
    expect(classifyTicket({ ...base, issueType: 'Story', subjectCommits: [commit('fix: [HIMMEL-9001] x')] }))
      .toMatchObject({ disposition: 'LEAVE', reason: 'epic-or-story' });
  });

  it('is idempotent: already commented by this tool -> no-op', () => {
    expect(
      classifyTicket({
        ...base,
        commentBodies: [TOOL_EVIDENCE_MARKER],
        subjectCommits: [commit('fix: [HIMMEL-9001] x')],
      }),
    ).toMatchObject({ disposition: 'LEAVE', reason: 'already-dispositioned' });
  });

  it('is idempotent: already at target status -> no-op', () => {
    expect(
      classifyTicket({ ...base, status: 'Done', subjectCommits: [commit('fix: [HIMMEL-9001] x')] }),
    ).toMatchObject({ disposition: 'LEAVE', reason: 'already-at-target' });
  });

  it('is idempotent: hygiene-sweep dispositioned with no comment -> no-op (the fixed gap)', () => {
    expect(
      classifyTicket({
        ...base,
        hygieneKeys: new Set(['HIMMEL-9001']),
        subjectCommits: [commit('fix: [HIMMEL-9001] x')],
      }),
    ).toMatchObject({ disposition: 'LEAVE', reason: 'already-dispositioned-by-hygiene-sweep' });
  });

  it('leaves a ticket with no project target status configured, not a failure', () => {
    expect(
      classifyTicket({ ...base, targetStatus: undefined, subjectCommits: [commit('fix: [HIMMEL-9001] x')] }),
    ).toMatchObject({ disposition: 'LEAVE', reason: 'no-project-config' });
  });

  it('leaves a ticket with only a body-only match', () => {
    expect(
      classifyTicket({ ...base, bodyOnlyCommits: [commit('unrelated', { body: 'HIMMEL-9001 mentioned' })] }),
    ).toMatchObject({ disposition: 'LEAVE', reason: 'body-only-match' });
  });

  it('leaves a ticket with no evidence at all', () => {
    expect(classifyTicket({ ...base })).toMatchObject({ disposition: 'LEAVE', reason: 'no-evidence' });
  });

  it('leaves (never closes) when the top subject match is a revert', () => {
    expect(
      classifyTicket({ ...base, subjectCommits: [commit('revert: [HIMMEL-9001] drop the thing')] }),
    ).toMatchObject({ disposition: 'LEAVE', reason: 'revert' });
  });

  it('rescopes (never closes) on a partial-delivery marker', () => {
    expect(
      classifyTicket({ ...base, subjectCommits: [commit('fix: [HIMMEL-9001] thing (PR 1 of 2 — core)')] }),
    ).toMatchObject({ disposition: 'RESCOPE', reason: 'partial-delivery' });
  });

  it('closes on a clean subject match', () => {
    const result = classifyTicket({ ...base, subjectCommits: [commit('fix: [HIMMEL-9001] ship the thing', { sha: 'zzz' })] });
    expect(result.disposition).toBe('CLOSE');
    expect(result.reason).toBe('subject-match');
    expect(result.evidence.sha).toBe('zzz');
  });

  it('most-recent subject commit decides when several match', () => {
    const result = classifyTicket({
      ...base,
      subjectCommits: [
        commit('revert: [HIMMEL-9001] drop the thing', { sha: 'newest', date: '2026-09-15' }),
        commit('fix: [HIMMEL-9001] ship the thing', { sha: 'older', date: '2026-09-01' }),
      ],
    });
    expect(result).toMatchObject({ disposition: 'LEAVE', reason: 'revert' });
    expect(result.evidence.sha).toBe('newest');
  });
});

describe('applyDisposition', () => {
  function makeClient() {
    const calls = [];
    return {
      calls,
      client: {
        async comment(key, body) {
          calls.push(['comment', key, body]);
        },
        async transition(key, status) {
          calls.push(['transition', key, status]);
        },
      },
    };
  }

  it('does nothing for LEAVE', async () => {
    const { calls, client } = makeClient();
    const result = await applyDisposition({ key: 'HIMMEL-1', disposition: 'LEAVE', jiraClient: client });
    expect(result).toEqual({ action: 'none' });
    expect(calls).toEqual([]);
  });

  it('comments then transitions for CLOSE, in that order', async () => {
    const { calls, client } = makeClient();
    const result = await applyDisposition({
      key: 'HIMMEL-1',
      disposition: 'CLOSE',
      targetStatus: 'Done',
      commentBody: 'evidence',
      jiraClient: client,
    });
    expect(result).toEqual({ action: 'commented+transitioned' });
    expect(calls).toEqual([
      ['comment', 'HIMMEL-1', 'evidence'],
      ['transition', 'HIMMEL-1', 'Done'],
    ]);
  });

  it('comments only for RESCOPE, never transitions', async () => {
    const { calls, client } = makeClient();
    const result = await applyDisposition({
      key: 'HIMMEL-1',
      disposition: 'RESCOPE',
      commentBody: 'evidence',
      jiraClient: client,
    });
    expect(result).toEqual({ action: 'commented' });
    expect(calls).toEqual([['comment', 'HIMMEL-1', 'evidence']]);
  });
});

describe('buildEvidenceComment', () => {
  it('includes the tool marker, disposition, reason and evidence commit', () => {
    const text = buildEvidenceComment({
      key: 'HIMMEL-1',
      disposition: 'CLOSE',
      reason: 'subject-match',
      evidence: commit('fix: [HIMMEL-1] thing', { sha: 'abc1234', date: '2026-09-16' }),
    });
    expect(text).toContain(TOOL_EVIDENCE_MARKER);
    expect(text).toContain('CLOSE');
    expect(text).toContain('subject-match');
    expect(text).toContain('abc1234');
  });

  it('omits an evidence line when there is none', () => {
    const text = buildEvidenceComment({ key: 'HIMMEL-1', disposition: 'LEAVE', reason: 'no-evidence', evidence: null });
    expect(text).not.toContain('Evidence:');
  });
});
