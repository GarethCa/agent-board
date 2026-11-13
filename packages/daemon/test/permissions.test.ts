import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { answerProblem, createPermissionHolds, permissionReply, promptCounts, questionsOf, stateWithPrompts } from '../src/permissions.ts';
import { DIALOG_TAKE_MS, needsYouKind, type Agent } from '../src/protocol.ts';

const BASH = { tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } };
const request = (fields: Record<string, unknown> = {}) => ({ hook_event_name: 'PermissionRequest', ...BASH, ...fields });
const hook = (hook_event_name: string, fields: Record<string, unknown> = {}) => ({ hook_event_name, ...fields });
const inSubagent = (id: string) => ({ agent_id: id, agent_type: 'general-purpose' });

const HOLD_MS = 1_000;
const ASKING_HOLD_MS = 60_000;
const T0 = new Date('2026-10-09T10:00:00.000Z');

function holds() {
  const changed: string[] = [];
  const dropped: string[] = [];
  const permissions = createPermissionHolds({
    holdMs: HOLD_MS,
    askingHoldMs: ASKING_HOLD_MS,
    onChange: (sessionId) => changed.push(sessionId),
    onAnswersDropped: (sessionId) => dropped.push(sessionId),
  });
  return { permissions, changed, dropped };
}

const open = () => new AbortController().signal;

/** Whether `promise` has settled, and with what, after pending microtasks run. */
async function settled<T>(promise: Promise<T>): Promise<{ value: T } | undefined> {
  let result: { value: T } | undefined;
  void promise.then((value) => (result = { value }));
  await vi.advanceTimersByTimeAsync(0);
  return result;
}

// The daemon-level journeys (allow, deny, lapse, two subagents at once) are in agents.test.ts, with the fake claude.
// These pin the rules for what settles a prompt, which the fake can't reach one by one.
describe('permission holds', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  it('holds a PermissionRequest open as a prompt until the user decides', async () => {
    const { permissions } = holds();
    const reply = permissions.hold('s1', request(), open());

    const [prompt] = permissions.prompts('s1');
    expect(prompt).toEqual({
      id: expect.any(String),
      toolName: 'Bash',
      toolInput: { command: 'rm -rf dist' },
      subagent: null,
      requestedAt: T0.toISOString(),
      heldUntil: new Date(T0.getTime() + HOLD_MS).toISOString(),
      asksInTerminal: false,
      sessionGrant: null,
      questions: null,
      dialog: null,
      plan: null,
    });
    expect(await settled(reply)).toBeUndefined();

    expect(permissions.decide('s1', prompt!.id, { behavior: 'allow' })).toBe(true);
    expect(await reply).toEqual(permissionReply({ behavior: 'allow' }));
    expect(permissions.prompts('s1')).toEqual([]);
  });

  it("answers in the harness's PermissionRequest decision shape, with a deny's reason", () => {
    expect(permissionReply({ behavior: 'allow' })).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
    expect(permissionReply({ behavior: 'deny', message: 'Not on main' })).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Not on main' } },
    });
  });

  describe('allowing for the session', () => {
    const suggestion = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'pnpm test:*' }], behavior: 'allow', destination: 'localSettings' };

    it("is offered only for a request that carries the harness's own suggestions, and sends them scoped to the session", async () => {
      const { permissions } = holds();
      const without = permissions.hold('s1', request({ permission_suggestions: [] }), open());
      const withSuggestion = permissions.hold('s1', request({ permission_suggestions: [suggestion] }), open());
      const [none, some] = permissions.prompts('s1');
      expect(none!.sessionGrant).toBeNull();
      expect(some!.sessionGrant).toBe('pnpm test:*');

      // A request with nothing to scope can't be allowed for the session: it stays held.
      expect(permissions.decide('s1', none!.id, { behavior: 'allow', scope: 'session' })).toBe(false);
      expect(await settled(without)).toBeUndefined();

      expect(permissions.decide('s1', some!.id, { behavior: 'allow', scope: 'session' })).toBe(true);
      expect(await withSuggestion).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'allow', updatedPermissions: [{ ...suggestion, destination: 'session' }] },
        },
      });
    });

    it('sends a plain allow when the user allows it once, suggestions or not', async () => {
      const { permissions } = holds();
      const reply = permissions.hold('s1', request({ permission_suggestions: [suggestion] }), open());
      permissions.decide('s1', permissions.prompts('s1')[0]!.id, { behavior: 'allow' });
      expect(await reply).toEqual(permissionReply({ behavior: 'allow' }));
    });

    it.each([
      [[{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm run:*' }], behavior: 'allow', destination: 'localSettings' }], 'npm run:*'],
      [[{ type: 'addRules', rules: [{ toolName: 'WebFetch', ruleContent: 'domain:example.com' }], behavior: 'allow' }], 'WebFetch(domain:example.com)'],
      [[{ type: 'addRules', rules: [{ toolName: 'Read' }], behavior: 'allow' }], 'all Read calls'],
      [[{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }], 'all edits'],
      [[{ type: 'addDirectories', directories: ['/tmp/a', '/tmp/b'], destination: 'session' }], '/tmp/a, /tmp/b'],
      [
        [
          { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls' }], behavior: 'allow' },
          { type: 'setMode', mode: 'acceptEdits' },
        ],
        'ls and all edits',
      ],
      // Anything it can't word is not offered: the user would grant more than the button says.
      [[{ type: 'setMode', mode: 'bypassPermissions' }], null],
      [[{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls' }], behavior: 'deny' }], null],
      [[{ type: 'replaceRules', rules: [] }], null],
      [[{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls' }], behavior: 'allow' }, { type: 'mystery' }], null],
    ])('words what an allow for the session grants: %j -> %s', (suggestions, grant) => {
      const { permissions } = holds();
      void permissions.hold('s1', request({ permission_suggestions: suggestions }), open());
      expect(permissions.prompts('s1')[0]!.sessionGrant).toBe(grant);
    });

    it('ignores suggestions that are not objects, and never scopes a deny', async () => {
      const { permissions } = holds();
      const reply = permissions.hold('s1', request({ permission_suggestions: ['x', null, 3] }), open());
      expect(permissions.prompts('s1')[0]!.sessionGrant).toBeNull();
      permissions.decide('s1', permissions.prompts('s1')[0]!.id, { behavior: 'deny', scope: 'session' });
      expect(await reply).toEqual(permissionReply({ behavior: 'deny' }));
    });
  });

  it('releases a held request with no decision, so the harness asks now, and keeps it listed as asking there', async () => {
    const { permissions, changed } = holds();
    const reply = permissions.hold('s1', request(), open());
    const [prompt] = permissions.prompts('s1');
    expect(permissions.release('s1', prompt!.id)).toBe(true);
    expect(await reply).toBeUndefined();
    expect(permissions.prompts('s1')).toEqual([{ ...prompt, heldUntil: null }]);
    expect(changed).toEqual([]);
    // Once released it can't be decided or released again.
    expect(permissions.release('s1', prompt!.id)).toBe(false);
    expect(permissions.decide('s1', prompt!.id, { behavior: 'allow' })).toBe(false);
  });

  it('holds every request at once, each answered on its own', async () => {
    const { permissions } = holds();
    const first = permissions.hold('s1', request(inSubagent('a1')), open());
    const second = permissions.hold('s1', request({ ...inSubagent('a2'), tool_input: { command: 'rm -rf build' } }), open());

    const [one, two] = permissions.prompts('s1');
    expect(one).toMatchObject({ subagent: { id: 'a1', type: 'general-purpose' }, toolInput: { command: 'rm -rf dist' } });
    expect(two).toMatchObject({ subagent: { id: 'a2', type: 'general-purpose' }, toolInput: { command: 'rm -rf build' } });

    permissions.decide('s1', two!.id, { behavior: 'deny' });
    expect(await second).toEqual(permissionReply({ behavior: 'deny' }));
    expect(await settled(first)).toBeUndefined();
    expect(permissions.prompts('s1')).toEqual([one]);
  });

  it('refuses a decision for another request or session, or one already made', () => {
    const { permissions } = holds();
    void permissions.hold('s1', request(), open());
    const { id } = permissions.prompts('s1')[0]!;

    expect(permissions.decide('s1', 'other-id', { behavior: 'allow' })).toBe(false);
    expect(permissions.decide('s2', id, { behavior: 'allow' })).toBe(false);
    expect(permissions.decide('s1', id, { behavior: 'deny' })).toBe(true);
    expect(permissions.decide('s1', id, { behavior: 'allow' })).toBe(false);
  });

  it('lets the hold lapse to the terminal with no decision, keeping the prompt as context until it is settled there', async () => {
    const { permissions, changed } = holds();
    const reply = permissions.hold('s1', request(), open());
    const { id } = permissions.prompts('s1')[0]!;

    await vi.advanceTimersByTimeAsync(HOLD_MS);

    expect(await settled(reply)).toEqual({ value: undefined });
    expect(changed).toEqual(['s1']);
    expect(permissions.prompts('s1')).toEqual([expect.objectContaining({ id, heldUntil: null })]);
    expect(permissions.decide('s1', id, { behavior: 'allow' })).toBe(false);
    // The terminal's own prompt for it settles nothing.
    expect(permissions.afterHook('s1', hook('Notification', { notification_type: 'permission_prompt' }))).toBe(false);
    // Allowed in the terminal: that very call ran.
    expect(permissions.afterHook('s1', hook('PostToolUse', BASH))).toBe(true);
    expect(permissions.prompts('s1')).toEqual([]);
  });

  it('holds a request its terminal asks at the same time for the long hold, so the inbox can still answer it after the short one', async () => {
    const { permissions, changed } = holds();
    const reply = permissions.hold('s1', request(), open(), true);
    const [prompt] = permissions.prompts('s1');
    expect(prompt).toMatchObject({ asksInTerminal: true, heldUntil: new Date(T0.getTime() + ASKING_HOLD_MS).toISOString() });

    await vi.advanceTimersByTimeAsync(HOLD_MS * 5);
    expect(await settled(reply)).toBeUndefined();
    expect(changed).toEqual([]);

    expect(permissions.decide('s1', prompt!.id, { behavior: 'allow' })).toBe(true);
    expect(await reply).toEqual(permissionReply({ behavior: 'allow' }));
  });

  it('lets a request its terminal asks too lapse at the long hold, and settles it once it is answered in the terminal', async () => {
    const { permissions, changed } = holds();
    const lapsing = permissions.hold('s1', request(), open(), true);
    await vi.advanceTimersByTimeAsync(ASKING_HOLD_MS);
    expect(await settled(lapsing)).toEqual({ value: undefined });
    expect(changed).toEqual(['s1']);
    expect(permissions.afterHook('s1', hook('Stop'))).toBe(true);

    // Allowed in its terminal while held: the call runs, which releases the hook and clears the prompt.
    const answered = permissions.hold('s1', request(), open(), true);
    expect(permissions.afterHook('s1', hook('PostToolUse', BASH))).toBe(true);
    expect(await settled(answered)).toEqual({ value: undefined });
    expect(permissions.prompts('s1')).toEqual([]);

    // Or it runs and fails: Claude says so with PostToolUseFailure, never a PostToolUse.
    const failed = permissions.hold('s1', request(), open(), true);
    expect(permissions.afterHook('s1', hook('PostToolUseFailure', { ...BASH, error: 'exit 1' }))).toBe(true);
    expect(await settled(failed)).toEqual({ value: undefined });
    expect(permissions.prompts('s1')).toEqual([]);
  });

  it('stops holding when the harness hangs up', async () => {
    const { permissions, changed } = holds();
    const abort = new AbortController();
    const reply = permissions.hold('s1', request(), abort.signal);

    abort.abort();

    expect(await settled(reply)).toEqual({ value: undefined });
    expect(changed).toEqual(['s1']);
    expect(permissions.prompts('s1')).toEqual([expect.objectContaining({ heldUntil: null })]);
    await vi.advanceTimersByTimeAsync(HOLD_MS);
    expect(changed).toEqual(['s1']);
  });

  it('settles a prompt once its own call runs, or its asker ends its turn or takes a new prompt', async () => {
    for (const [settling, fields] of [
      ['PostToolUse', BASH],
      ['Stop', {}],
      ['StopFailure', { error: 'rate_limit' }],
      ['Interrupt', {}],
      ['UserPromptSubmit', { prompt: 'never mind' }],
    ] as const) {
      const { permissions } = holds();
      const reply = permissions.hold('s1', request(), open());
      expect(permissions.afterHook('s1', hook(settling, fields)), settling).toBe(true);
      expect(await settled(reply), settling).toEqual({ value: undefined });
      expect(permissions.prompts('s1'), settling).toEqual([]);
    }
  });

  it('keeps a prompt through calls that may run beside it: other tools, or the same tool on other input', () => {
    const { permissions } = holds();
    void permissions.hold('s1', request(), open());

    expect(permissions.afterHook('s1', hook('PreToolUse', BASH))).toBe(false);
    expect(permissions.afterHook('s1', hook('PostToolUse', { tool_name: 'Read', tool_input: { file_path: '/a' } }))).toBe(false);
    expect(permissions.afterHook('s1', hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }))).toBe(false);
    expect(permissions.prompts('s1')).toHaveLength(1);
  });

  it("ties a subagent's prompt to that subagent: only its own hooks, or its end, settle it", () => {
    const { permissions } = holds();
    void permissions.hold('s1', request(inSubagent('a1')), open());
    void permissions.hold('s1', request(inSubagent('a2')), open());

    // The parent's turn ending leaves background subagents asking.
    expect(permissions.afterHook('s1', hook('Stop'))).toBe(false);
    expect(permissions.afterHook('s1', hook('PostToolUse', BASH))).toBe(false);
    expect(permissions.afterHook('s1', hook('PostToolUse', { ...BASH, ...inSubagent('a2') }))).toBe(true);
    expect(permissions.prompts('s1')).toEqual([expect.objectContaining({ subagent: { id: 'a1', type: 'general-purpose' } })]);
    expect(permissions.afterHook('s1', hook('SubagentStop', inSubagent('a1')))).toBe(true);
    expect(permissions.prompts('s1')).toEqual([]);
  });

  it("keeps sessions apart, and drops a session's prompts when it ends", async () => {
    const { permissions } = holds();
    const one = permissions.hold('s1', request(), open());
    void permissions.hold('s2', request(), open());

    permissions.drop('s1');

    expect(await settled(one)).toEqual({ value: undefined });
    expect(permissions.prompts('s1')).toEqual([]);
    expect(permissions.prompts('s2')).toHaveLength(1);
  });

  it('tells no one once closed', async () => {
    const { permissions, changed } = holds();
    const reply = permissions.hold('s1', request(), open());

    permissions.close();
    await vi.advanceTimersByTimeAsync(HOLD_MS);

    expect(await settled(reply)).toEqual({ value: undefined });
    expect(changed).toEqual([]);
  });
});

const QUESTIONS = [
  {
    question: 'Which cache should the build use?',
    header: 'Cache',
    options: [
      { label: 'Redis', description: 'Shared across machines' },
      { label: 'In memory', description: 'Per process' },
    ],
    multiSelect: false,
  },
];
const askQuestion = (fields: Record<string, unknown> = {}) => request({ tool_name: 'AskUserQuestion', tool_input: { questions: QUESTIONS }, ...fields });

describe("Claude's question tool", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  it("lists its call as questions, not a permission, and holds it while Claude's own dialog asks too", async () => {
    const { permissions } = holds();
    const reply = permissions.hold('s1', askQuestion(), open(), true);

    expect(await settled(reply)).toBeUndefined();
    const [prompt] = permissions.prompts('s1');
    expect(prompt).toMatchObject({
      toolName: 'AskUserQuestion',
      heldUntil: new Date(T0.getTime() + ASKING_HOLD_MS).toISOString(),
      sessionGrant: null,
      questions: QUESTIONS,
      dialog: { answers: [null], sentAt: null, keptOpen: false },
      plan: null,
    });
    expect(promptCounts(permissions.prompts('s1'))).toEqual({ pending: 0, questions: 1 });
  });

  it("never holds a subagent's, nor one whose questions can't all be read: only its terminal answers those", async () => {
    const { permissions } = holds();
    expect(await settled(permissions.hold('s1', askQuestion(inSubagent('a1')), open(), false))).toEqual({ value: undefined });
    const unreadable = askQuestion({ tool_input: { questions: [...QUESTIONS, { question: '' }] } });
    expect(await settled(permissions.hold('s2', unreadable, open(), true))).toEqual({ value: undefined });
    const noOptions = askQuestion({ tool_input: { questions: [{ question: 'Go?', options: [] }] } });
    expect(await settled(permissions.hold('s3', noOptions, open(), true))).toEqual({ value: undefined });
    for (const sessionId of ['s1', 's2', 's3']) expect(permissions.prompts(sessionId)).toEqual([expect.objectContaining({ heldUntil: null, dialog: null })]);
  });

  it('can be neither allowed nor denied from the board, only answered', async () => {
    const { permissions } = holds();
    const reply = permissions.hold('s1', askQuestion(), open(), true);
    const [prompt] = permissions.prompts('s1');

    expect(permissions.decide('s1', prompt!.id, { behavior: 'allow' })).toBe(false);
    expect(permissions.decide('s1', prompt!.id, { behavior: 'deny' })).toBe(false);
    expect(await settled(reply)).toBeUndefined();
    expect(permissions.prompts('s1')).toHaveLength(1);
  });

  it('keeps the answers on the prompt, sending nothing, until they are sent: then allows with them as its updatedInput', async () => {
    const { permissions, changed } = holds();
    const two = [QUESTIONS[0]!, { question: 'Which pages?', header: 'Scope', options: [{ label: 'Product', description: '' }, { label: 'Category', description: '' }, { label: 'Search', description: '' }], multiSelect: true }];
    const reply = permissions.hold('s1', askQuestion({ tool_input: { questions: two } }), open(), true);
    const id = permissions.prompts('s1')[0]!.id;

    expect(permissions.sendAnswers('s1', id)).toBe(false);
    expect(permissions.answerQuestion('s1', id, 0, { option: 0 })).toBe(true);
    expect(permissions.answerQuestion('s1', id, 1, { options: [1, 0] })).toBe(true);
    expect(permissions.prompts('s1')[0]!.dialog!.answers).toEqual([{ option: 0 }, { options: [1, 0] }]);
    expect(await settled(reply)).toBeUndefined();

    expect(permissions.sendAnswers('s1', id)).toBe(true);
    expect(await reply).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', updatedInput: { questions: two, answers: { 'Which cache should the build use?': 'Redis', 'Which pages?': 'Product, Category' } } },
      },
    });
    // Sent: it stays, no longer held, until its call runs.
    expect(permissions.prompts('s1')).toEqual([expect.objectContaining({ id, heldUntil: null, dialog: { answers: [{ option: 0 }, { options: [1, 0] }], sentAt: T0.toISOString(), keptOpen: false } })]);
    expect(permissions.answerQuestion('s1', id, 0, { option: 1 })).toBe(false);
    expect(permissions.sendAnswers('s1', id)).toBe(false);
    expect(changed).toEqual([]);
  });

  it("answers in the user's own words, and a cleared answer is unanswered again", async () => {
    const { permissions } = holds();
    const reply = permissions.hold('s1', askQuestion(), open(), true);
    const id = permissions.prompts('s1')[0]!.id;
    permissions.answerQuestion('s1', id, 0, { option: 1 });
    permissions.answerQuestion('s1', id, 0, null);
    expect(permissions.sendAnswers('s1', id)).toBe(false);
    permissions.answerQuestion('s1', id, 0, { text: '  Memcached ' });
    permissions.sendAnswers('s1', id);
    expect(await reply).toMatchObject({ hookSpecificOutput: { decision: { updatedInput: { answers: { 'Which cache should the build use?': 'Memcached' } } } } });
  });

  it("says Claude kept its dialog open once its call hasn't run a while after the answers were sent, and settles as before once it runs", async () => {
    const { permissions, changed } = holds();
    void permissions.hold('s1', askQuestion(), open(), true);
    const id = permissions.prompts('s1')[0]!.id;
    permissions.answerQuestion('s1', id, 0, { option: 0 });
    permissions.sendAnswers('s1', id);

    await vi.advanceTimersByTimeAsync(DIALOG_TAKE_MS - 1);
    expect(permissions.prompts('s1')[0]!.dialog!.keptOpen).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(permissions.prompts('s1')[0]!.dialog!.keptOpen).toBe(true);
    expect(changed).toEqual(['s1']);

    // Answered in its terminal after all, with the user's own pick.
    expect(permissions.afterHook('s1', hook('PostToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions: QUESTIONS, answers: { 'Which cache should the build use?': 'In memory' } } }))).toBe(true);
    expect(permissions.prompts('s1')).toEqual([]);
  });

  it('tells when a call it sent answers to runs without them, and not when it runs with them or answered in its terminal', async () => {
    const send = (permissions: ReturnType<typeof holds>['permissions']) => {
      void permissions.hold('s1', askQuestion(), open(), true);
      const id = permissions.prompts('s1')[0]!.id;
      permissions.answerQuestion('s1', id, 0, { option: 0 });
      permissions.sendAnswers('s1', id);
    };
    const ran = (answers: Record<string, string> | undefined, event = 'PostToolUse') =>
      hook(event, { tool_name: 'AskUserQuestion', tool_input: answers === undefined ? { questions: QUESTIONS } : { questions: QUESTIONS, answers } });

    const dropping = holds();
    send(dropping.permissions);
    expect(dropping.permissions.afterHook('s1', ran({}))).toBe(true);
    expect(dropping.permissions.prompts('s1')).toEqual([]);
    expect(dropping.dropped).toEqual(['s1']);

    const taking = holds();
    send(taking.permissions);
    taking.permissions.afterHook('s1', ran({ 'Which cache should the build use?': 'Redis' }));
    // The user's own answer, typed in the terminal before Claude took the board's.
    send(taking.permissions);
    taking.permissions.afterHook('s1', ran({ 'Which cache should the build use?': 'In memory' }));
    // Never sent from the board: nothing of the board's was dropped.
    void taking.permissions.hold('s1', askQuestion(), open(), true);
    taking.permissions.afterHook('s1', ran(undefined));
    // A failed call, or the turn ending, isn't the call running without them.
    send(taking.permissions);
    taking.permissions.afterHook('s1', ran({}, 'PostToolUseFailure'));
    send(taking.permissions);
    taking.permissions.afterHook('s1', hook('Stop'));
    expect(taking.dropped).toEqual([]);
  });

  it('never says its dialog was kept open once its call ran in time', async () => {
    const { permissions, changed } = holds();
    void permissions.hold('s1', askQuestion(), open(), true);
    const id = permissions.prompts('s1')[0]!.id;
    permissions.answerQuestion('s1', id, 0, { option: 0 });
    permissions.sendAnswers('s1', id);
    permissions.afterHook('s1', hook('PostToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions: QUESTIONS, answers: { 'Which cache should the build use?': 'Redis' } } }));
    await vi.advanceTimersByTimeAsync(DIALOG_TAKE_MS);
    expect(changed).toEqual([]);
  });

  it("refuses an answer for a prompt that is gone or was answered in its terminal, and for another prompt's id", async () => {
    const { permissions } = holds();
    void permissions.hold('s1', askQuestion(), open(), true);
    const first = permissions.prompts('s1')[0]!.id;
    permissions.afterHook('s1', hook('PostToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions: QUESTIONS } }));
    void permissions.hold('s1', askQuestion(), open(), true);

    expect(permissions.answerQuestion('s1', first, 0, { option: 0 })).toBe(false);
    expect(permissions.sendAnswers('s1', first)).toBe(false);
    expect(permissions.prompts('s1')[0]!.dialog!.answers).toEqual([null]);
  });

  it('checks an answer against its question: an option it has, several only where it takes several, words not blank', () => {
    const single = QUESTIONS[0]!;
    const multi = { ...single, multiSelect: true };
    expect(answerProblem(single, { option: 1 })).toBeUndefined();
    expect(answerProblem(single, { option: 2 })).toMatch(/option/);
    expect(answerProblem(single, { option: -1 })).toMatch(/option/);
    expect(answerProblem(single, { options: [0] })).toMatch(/one/);
    expect(answerProblem(multi, { options: [0, 1] })).toBeUndefined();
    expect(answerProblem(multi, { options: [] })).toMatch(/option/);
    expect(answerProblem(multi, { options: [0, 0] })).toMatch(/option/);
    expect(answerProblem(multi, { option: 0 })).toBeUndefined();
    expect(answerProblem(single, { text: '  ' })).toMatch(/words/);
    expect(answerProblem(single, { text: 'Memcached' })).toBeUndefined();
  });

  it('is settled by its call running, whatever its input comes back with (its answers added), but not by another tool or asker', () => {
    const { permissions } = holds();
    void permissions.hold('s1', askQuestion(), open(), true);
    const answered = { questions: [{ ...QUESTIONS[0], extra: true }], answers: { 'Which cache should the build use?': 'Redis' } };

    expect(permissions.afterHook('s1', hook('PostToolUse', { ...BASH }))).toBe(false);
    expect(permissions.afterHook('s1', hook('PostToolUse', { tool_name: 'AskUserQuestion', tool_input: answered, ...inSubagent('a1') }))).toBe(false);
    expect(permissions.afterHook('s1', hook('PostToolUse', { tool_name: 'AskUserQuestion', tool_input: answered }))).toBe(true);
    expect(permissions.prompts('s1')).toEqual([]);
  });

  it('keeps the questions it can read and drops malformed ones', () => {
    expect(questionsOf({ tool_name: 'Bash', tool_input: { questions: QUESTIONS } })).toBeNull();
    expect(questionsOf({ tool_name: 'AskUserQuestion', tool_input: {} })).toEqual([]);
    expect(questionsOf({ tool_name: 'AskUserQuestion', tool_input: { questions: [null, { question: '' }, { question: 'Go?', options: [{ label: 'Yes' }, { nope: 1 }] }] } })).toEqual([
      { question: 'Go?', header: '', options: [{ label: 'Yes', description: '' }], multiSelect: false },
    ]);
  });

  it('puts the agent in Needs you as asking, not as asking for permission', () => {
    const prompt = { id: 'q', toolName: 'AskUserQuestion', toolInput: { questions: QUESTIONS }, subagent: null, requestedAt: T0.toISOString(), heldUntil: null, asksInTerminal: true, sessionGrant: null, questions: QUESTIONS, dialog: null, plan: null };
    const agent: Pick<Agent, 'endedAt' | 'state' | 'permissions' | 'ask' | 'removeAsk' | 'plan' | 'stepsWait' | 'flag' | 'ledBy'> = { endedAt: null, state: 'waiting', permissions: [prompt], ask: null, removeAsk: null, plan: null, stepsWait: null, flag: null, ledBy: null };

    expect(needsYouKind(agent, 'explicit')).toBe('asks');
    expect(needsYouKind({ ...agent, permissions: [prompt, { ...prompt, id: 'p', toolName: 'Bash', questions: null }] }, 'explicit')).toBe('permission');
  });
});

describe("Claude's plan tool", () => {
  it('holds its call as a permission, with its plan to read and the switch to accept edits it offers', async () => {
    const { permissions } = holds();
    const plan = '# Add a cache\n\n1. Add a client';
    const reply = permissions.hold('s1', request({ tool_name: 'ExitPlanMode', tool_input: { plan }, permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] }), open(), true);
    const [prompt] = permissions.prompts('s1');
    expect(prompt).toMatchObject({ toolName: 'ExitPlanMode', plan, sessionGrant: 'all edits', questions: null, dialog: null });
    expect(promptCounts(permissions.prompts('s1'))).toEqual({ pending: 1, questions: 0 });

    expect(permissions.decide('s1', prompt!.id, { behavior: 'deny', message: 'Use the LRU first' })).toBe(true);
    expect(await reply).toEqual(permissionReply({ behavior: 'deny', message: 'Use the LRU first' }));
  });

  it('approves it always saying the mode to go on in, whatever Claude suggested, so it never stays in plan mode', async () => {
    const mode = (reply: unknown) => (reply as { hookSpecificOutput: { decision: { behavior: string; updatedPermissions?: unknown } } }).hookSpecificOutput.decision;
    for (const suggestions of [[{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }], [], undefined]) {
      const { permissions } = holds();
      const fields = { tool_name: 'ExitPlanMode', tool_input: { plan: '# Plan' }, ...(suggestions === undefined ? {} : { permission_suggestions: suggestions }) };
      const auto = permissions.hold('s1', request(fields), open(), true);
      const first = permissions.prompts('s1')[0]!;
      // Auto-accept edits is offered whether or not Claude suggested it: the reply sets it.
      expect(first.sessionGrant).toBe('all edits');
      expect(permissions.decide('s1', first.id, { behavior: 'allow', scope: 'session' })).toBe(true);
      expect(mode(await auto)).toEqual({ behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] });

      const each = permissions.hold('s1', request(fields), open(), true);
      expect(permissions.decide('s1', permissions.prompts('s1')[0]!.id, { behavior: 'allow' })).toBe(true);
      expect(mode(await each)).toEqual({ behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'default', destination: 'session' }] });
    }
  });

  it("has no plan to read where its input has none, nor for any other tool", () => {
    const { permissions } = holds();
    void permissions.hold('s1', request({ tool_name: 'ExitPlanMode', tool_input: {} }), open(), true);
    void permissions.hold('s1', request({ tool_input: { plan: 'not a plan' } }), open(), true);
    expect(permissions.prompts('s1').map((prompt) => prompt.plan)).toEqual([null, null]);
  });
});

describe("an agent's state with its permission prompts", () => {
  it('waits for the user, not for a permission, while only questions are up', () => {
    for (const state of ['running', 'thinking', 'needs-permission'] as const) {
      expect(stateWithPrompts(state, { pending: 0, questions: 1, settled: false }), state).toBe('waiting');
    }
    expect(stateWithPrompts('running', { pending: 1, questions: 1, settled: false })).toBe('needs-permission');
    expect(stateWithPrompts('done', { pending: 0, questions: 1, settled: false })).toBe('done');
  });

  it('needs permission while any prompt is pending, whatever else its hooks say', () => {
    for (const state of ['running', 'thinking', 'idle', 'waiting', 'needs-permission'] as const) {
      expect(stateWithPrompts(state, { pending: 1, settled: false }), state).toBe('needs-permission');
    }
  });

  it('still ends, fails or hits a rate limit with prompts pending', () => {
    for (const state of ['done', 'failed', 'rate-limited'] as const) {
      expect(stateWithPrompts(state, { pending: 1, settled: false })).toBe(state);
    }
  });

  it('carries on running once its last prompt is settled by a hook that says nothing of its own state', () => {
    expect(stateWithPrompts('needs-permission', { pending: 0, settled: true })).toBe('running');
    expect(stateWithPrompts('idle', { pending: 0, settled: true })).toBe('idle');
  });

  it('leaves a needs-permission with no prompt of ours alone (the terminal asking on its own)', () => {
    expect(stateWithPrompts('needs-permission', { pending: 0, settled: false })).toBe('needs-permission');
  });
});
