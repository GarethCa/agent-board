import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RECORDED_LINEAR_FIXTURES } from '../src/testing.ts';
import { recordingLeaks, REDACTED_WORKSPACE, sanitiseRecording, type LinearRecording } from '../scripts/sanitise-linear.ts';

describe('the recorded Linear fixtures hold no private data', () => {
  const text = readFileSync(RECORDED_LINEAR_FIXTURES, 'utf8');
  const recording = JSON.parse(text) as LinearRecording;

  it('has the known issue and the team under test in it', () => {
    expect(text).toContain(`"identifier": "${recording.subject.knownIssue.id}"`);
    expect(text).toContain(`"key": "${recording.subject.scope}"`);
  });

  it('has no issue but the known one, no team but the one under test, and no workspace slug in a URL', () => {
    expect(recordingLeaks(text)).toEqual([]);
  });
});

describe('recordingLeaks', () => {
  const recording = (body: unknown) =>
    JSON.stringify({
      source: 'recorded',
      subject: { scope: 'ACME', knownIssue: { id: 'ACME-1' } },
      interactions: [{ request: { method: 'POST', url: 'u', body: {} }, response: { status: 200, body } }],
    });

  it('names every other issue, team and workspace slug', () => {
    const body = {
      data: {
        teams: { nodes: [{ key: 'ACME' }, { key: 'GAR' }] },
        issues: { nodes: [{ identifier: 'ACME-1', url: 'https://linear.app/workspace/issue/ACME-1/x' }, { identifier: 'ACME-2', url: 'https://linear.app/acme-inc/issue/ACME-2/y' }] },
      },
    };
    expect(recordingLeaks(recording(body))).toEqual(['issue ACME-2', 'team GAR', 'workspace slug acme-inc']);
  });

  it('finds nothing in a sanitised recording', () => {
    expect(recordingLeaks(recording({ data: { teams: { nodes: [{ key: 'ACME' }] }, issues: { nodes: [{ identifier: 'ACME-1' }] } } }))).toEqual([]);
  });
});

describe('sanitiseRecording', () => {
  const recording = (): LinearRecording => ({
    source: 'recorded',
    subject: { scope: 'ACME', knownIssue: { id: 'ACME-1' }, project: 'p-1' },
    interactions: [
      {
        request: { method: 'POST', url: 'u', body: {} },
        response: { status: 200, body: { data: { teams: { nodes: [{ key: 'ACME' }, { key: 'GAR' }] } } } },
      },
      {
        request: { method: 'POST', url: 'u', body: {} },
        response: {
          status: 200,
          body: { data: { issues: { nodes: [{ identifier: 'ACME-1' }, { identifier: 'ACME-2' }] } } },
        },
      },
      {
        request: { method: 'POST', url: 'u', body: {} },
        response: {
          status: 200,
          body: { data: { searchIssues: { nodes: [{ identifier: 'ACME-2' }, { identifier: 'ACME-1' }] } } },
        },
      },
      {
        request: { method: 'POST', url: 'u', body: {} },
        response: { status: 200, body: { data: { projects: { nodes: [{ id: 'p-1' }, { id: 'p-2' }] } } } },
      },
      { request: { method: 'POST', url: 'u', body: {} }, response: { status: 401, body: { errors: [] } } },
    ],
  });

  it("keeps only the team, scratch issue and project it is about, and redacts the workspace's slug", () => {
    const input = recording();
    input.subject.knownIssue = { id: 'ACME-1', url: 'https://linear.app/acme-inc/issue/ACME-1/x' } as never;
    const bodies = sanitiseRecording(input).interactions.map((i) => i.response.body);
    expect(bodies).toEqual([
      { data: { teams: { nodes: [{ key: 'ACME' }] } } },
      { data: { issues: { nodes: [{ identifier: 'ACME-1' }] } } },
      { data: { searchIssues: { nodes: [{ identifier: 'ACME-1' }] } } },
      { data: { projects: { nodes: [{ id: 'p-1' }] } } },
      { errors: [] },
    ]);
    expect(JSON.stringify(sanitiseRecording(input))).not.toContain('acme-inc');
    expect(JSON.stringify(sanitiseRecording(input))).toContain(`https://linear.app/${REDACTED_WORKSPACE}/issue/ACME-1/x`);
  });
});
