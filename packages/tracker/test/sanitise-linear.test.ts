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

  it('has no issue but the known one, no team but the one under test, no UUID but the fake ones, and no workspace slug in a URL', () => {
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

  it('names every UUID outside the fake range', () => {
    const body = { data: { projects: { nodes: [{ id: '3f2a9c1e-7b4d-4e8a-9c2f-5d6e7a8b9c0d' }, { id: '00000000-0000-4000-8000-000000000001' }] } } };
    expect(recordingLeaks(recording(body))).toEqual(['uuid 3f2a9c1e-7b4d-4e8a-9c2f-5d6e7a8b9c0d']);
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

describe('sanitiseRecording UUIDs', () => {
  const real = ['3f2a9c1e-7b4d-4e8a-9c2f-5d6e7a8b9c0d', '6b1e4d27-95a3-4c08-b7f1-2a9d8e3c5f40'];
  const recording = (): LinearRecording => ({
    source: 'recorded',
    subject: { scope: 'ACME', knownIssue: { id: 'ACME-1' }, project: real[0] },
    interactions: [
      {
        request: { method: 'POST', url: 'u', body: { variables: { filter: { project: { id: { eq: real[0] } } }, team: real[1] } } },
        response: { status: 200, body: { data: { projects: { nodes: [{ id: real[0] }] } } } },
      },
      {
        request: { method: 'POST', url: 'u', body: { variables: { id: '00000000-0000-4000-8000-0000000000ff' } } },
        response: { status: 200, body: { data: { teams: { nodes: [{ key: 'ACME', id: real[1] }] } } } },
      },
    ],
  });

  it('replaces each real UUID with the same fake one everywhere, in order, and leaves fake ones alone', () => {
    const out = sanitiseRecording(recording());
    const text = JSON.stringify(out);
    expect(text).not.toContain(real[0]);
    expect(text).not.toContain(real[1]);
    expect(out.subject.project).toBe('00000000-0000-4000-8000-000000000001');
    expect(out.interactions[0]?.request.body).toEqual({
      variables: { filter: { project: { id: { eq: '00000000-0000-4000-8000-000000000001' } } }, team: '00000000-0000-4000-8000-000000000002' },
    });
    expect(out.interactions[1]?.request.body).toEqual({ variables: { id: '00000000-0000-4000-8000-0000000000ff' } });
    expect(recordingLeaks(text)).toEqual([]);
  });

  it('is idempotent', () => {
    const once = JSON.stringify(sanitiseRecording(recording()));
    expect(JSON.stringify(sanitiseRecording(JSON.parse(once)))).toBe(once);
  });

  it('does not reuse a fake number already in the recording', () => {
    const input = recording();
    input.interactions[1]!.request.body = { variables: { id: '00000000-0000-4000-8000-000000000001' } };
    expect(JSON.stringify(sanitiseRecording(input))).toContain('00000000-0000-4000-8000-000000000002');
    expect(sanitiseRecording(input).subject.project).toBe('00000000-0000-4000-8000-000000000002');
  });
});
