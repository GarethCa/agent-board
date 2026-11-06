// The steps commands as the CLI and MCP give them (`steps new|ls|read|done|wait|add|answer|close`): the line format
// and refs turned into the daemon's steps methods, and the cards they answer with as text and JSON (ADR-0010's one API,
// two faces).
import { agentToken, BoardError, BoardRefs, inZone, readBoard, resolveAgent, type BoardSession, type BoardView } from './board-ops.ts';
import type { BoardItem, Step, StepAnswer, StepDraft, StepsChange, StepsData, StepsWho } from './protocol.ts';
import { answerWords, parseSteps, stepLine, StepsFormatError } from './steps-format.ts';

const stepsOf = (item: BoardItem) => item.data as unknown as StepsData;

/** `text` read as steps, `@who` resolved to the user, the caller (`@me`, or none), or an agent on the board. */
async function drafts(session: BoardSession, text: string): Promise<{ title: string | null; steps: StepDraft[] }> {
  let parsed;
  try {
    parsed = parseSteps(text);
  } catch (error) {
    if (error instanceof StepsFormatError) throw new BoardError(`can't read the steps: ${error.message}`);
    throw error;
  }
  const named = parsed.steps.some((step) => step.who !== null && step.who !== 'me' && step.who !== 'user');
  const refs = named ? new BoardRefs(await readBoard(session.client)) : undefined;
  const steps = parsed.steps.map(({ who, ...step }): StepDraft => {
    if (who === null || who === 'me') return { ...step, who: null };
    if (who === 'user') return { ...step, who: { kind: 'user' } };
    return { ...step, who: { kind: 'agent', sessionId: resolveAgent(refs!, who, session.caller).sessionId } };
  });
  return { title: parsed.title, steps };
}

/** How many of the card's to-dos are ticked and questions answered, of all its steps. */
const doneCount = (data: StepsData) => data.steps.filter((step) => step.done !== null || step.answer !== null).length;

/** The card in a line: its ref, title, how far through it is, who made it and where it is. */
function cardLine(refs: BoardRefs, item: BoardItem): string {
  const data = stepsOf(item);
  const state = data.closedAt !== null ? '  closed' : data.sent !== null ? '  answers sent' : '';
  return `${refs.of('item', item.id)}  “${data.title}”  ${doneCount(data)}/${data.steps.length} done${state}  by ${whoText(refs, data.madeBy)}  ${inZone(refs, item.zoneId)}`;
}

/** Who as the format writes it: `user`, or an agent's ref (its id's start once it is gone from the board). */
function whoRef(refs: BoardRefs, who: StepsWho): string {
  if (who.kind === 'user') return 'user';
  return refs.board.agents.some((agent) => agent.sessionId === who.sessionId) ? refs.of('agent', who.sessionId) : `agent:${who.sessionId.slice(0, 8)}`;
}
const whoText = (refs: BoardRefs, who: StepsWho) => (who.kind === 'user' ? 'the user' : `${whoRef(refs, who)} ${who.name}`);

/** The whole card: its line, then each step numbered in the line format, under its section, with its answer. */
function cardText(refs: BoardRefs, item: BoardItem): string {
  const data = stepsOf(item);
  const lines = [cardLine(refs, item), `  Its questions are answered by ${whoText(refs, data.answeredBy)}.`];
  let section: string | null = null;
  data.steps.forEach((step, at) => {
    if (step.section !== null && step.section !== section) lines.push(`  ## ${step.section}`);
    section = step.section;
    lines.push(`  ${at + 1}. ${stepLine(step, (who) => whoRef(refs, who))}`);
    if (step.answer !== null) lines.push(`       → ${answerWords(step, step.answer.value).replace(/\n/g, '\n         ')}  (${whoText(refs, step.answer.by)})`);
    else if (step.done !== null && step.who !== null && step.done.by.kind !== step.who.kind) lines.push(`       ticked by ${whoText(refs, step.done.by)}`);
  });
  return lines.join('\n');
}

/** The card `ref` names, as the daemon has it for the caller. */
async function cardFor(session: BoardSession, ref: string): Promise<{ refs: BoardRefs; item: BoardItem }> {
  const refs = new BoardRefs(await readBoard(session.client));
  const object = refs.resolve(ref, session.caller);
  if (object.kind !== 'item' || object.item.kind !== 'steps') throw new BoardError(`${ref} is not a steps card: \`agent-board steps ls\` lists them`);
  const [item] = await session.client.call('board.readSteps', { token: agentToken(session, 'read a steps card'), id: object.item.id });
  return { refs, item: item! };
}

/** `steps new`: a steps card beside the caller's tile, from lines in the format; a `# title` line, or `title`, names it. */
export async function newSteps(session: BoardSession, options: { title?: string; text: string }): Promise<BoardView> {
  const token = agentToken(session, 'put up a steps card');
  const { title, steps } = await drafts(session, options.text);
  const named = options.title?.trim() || title;
  if (named === null || named === undefined) throw new BoardError('give the card a title: a "# title" line, or --title');
  const item = await session.client.call('board.newSteps', { token, title: named, steps });
  const refs = new BoardRefs(await readBoard(session.client));
  const data = stepsOf(item);
  const asks = data.steps.some((step) => step.kind !== 'todo');
  const answers =
    data.answeredBy.kind === 'user'
      ? 'The user answers its questions; once they press Send, the answers are typed at your prompt. End your turn and wait for them.'
      : `${data.answeredBy.name}, which started you, answers its questions, and was told. Its answers come to your prompt once sent.`;
  return { text: `Put ${cardLine(refs, item)} beside your tile.${asks ? `\n${answers}` : ''}`, json: item };
}

/** `steps ls`: the steps cards the caller can read; with `mine`, those with a to-do of its not yet done. */
export async function listSteps(session: BoardSession, options: { mine?: boolean }): Promise<BoardView> {
  const items = await session.client.call('board.readSteps', { token: agentToken(session, 'list steps cards'), ...(options.mine === true ? { mine: true } : {}) });
  const refs = new BoardRefs(await readBoard(session.client));
  const none = options.mine === true ? 'No steps card has a to-do of yours not yet done.' : 'No steps cards you can read.';
  return { text: items.length === 0 ? none : items.map((item) => cardLine(refs, item)).join('\n'), json: items };
}

/** `steps read`: one card in full. */
export async function readStepsCard(session: BoardSession, ref: string): Promise<BoardView> {
  const { refs, item } = await cardFor(session, ref);
  return { text: cardText(refs, item), json: item };
}

/** The step `place` (from 1) of the card's, or a refusal naming how many it has. */
function stepAt(data: StepsData, place: number): Step {
  const step = data.steps[place - 1];
  if (!Number.isInteger(place) || step === undefined) throw new BoardError(`there is no step ${place}: the card has ${data.steps.length}`);
  return step;
}

/** A choice of `step`'s, named by its number (from 1) or its text. */
function choiceIndex(step: Step, said: string): number {
  const wanted = said.trim();
  const byNumber = /^\d+$/.test(wanted) ? Number(wanted) - 1 : -1;
  if (byNumber >= 0 && byNumber < step.choices.length) return byNumber;
  const byText = step.choices.findIndex((choice) => choice.toLowerCase() === wanted.toLowerCase());
  if (byText >= 0) return byText;
  throw new BoardError(`"${wanted}" is not one of its choices: ${step.choices.map((choice, at) => `${at + 1}. ${choice}`).join(', ')}`);
}

/** `said` as an answer to `step`: a choice by number or text, several split by commas, yes or no, or words. */
export function answerFrom(step: Step, said: string): StepAnswer {
  const text = said.trim();
  if (text === '') throw new BoardError('give the answer');
  switch (step.kind) {
    case 'one':
      return { one: choiceIndex(step, text) };
    case 'any':
      return { any: /^none$/i.test(text) ? [] : text.split(',').map((part) => choiceIndex(step, part)) };
    case 'yes-no':
      if (/^(?:y|yes)$/i.test(text)) return { yes: true };
      if (/^(?:n|no)$/i.test(text)) return { yes: false };
      throw new BoardError('answer yes or no');
    case 'order':
      return { order: text.split(',').map((part) => choiceIndex(step, part)) };
    case 'words':
      return { words: text };
    case 'todo':
      throw new BoardError('that step is a to-do: tick it with `steps done`');
  }
}

/** What `steps done|wait|add|answer|close` does, as typed. */
export type StepsUpdate =
  | { action: 'done'; steps: number[]; undo?: boolean }
  | { action: 'wait'; step: number }
  | { action: 'add'; text: string }
  | { action: 'answer'; step?: number; answer?: string; send?: boolean }
  | { action: 'close' };

/** `steps done|wait|add|answer|close`: changes the card `ref` names, as the caller may, and prints it after. */
export async function updateSteps(session: BoardSession, ref: string, update: StepsUpdate): Promise<BoardView> {
  const token = agentToken(session, 'change a steps card');
  const { refs, item } = await cardFor(session, ref);
  const change = (each: StepsChange) => session.client.call('board.updateSteps', { token, id: item.id, change: each });
  let changed = item;
  let said: string;
  switch (update.action) {
    case 'done': {
      if (update.steps.length === 0) throw new BoardError('give the number of each step to tick');
      for (const step of update.steps) changed = await change({ action: 'done', step, ...(update.undo === true ? { undo: true } : {}) });
      said = `${update.undo === true ? 'Unticked' : 'Ticked'} step${update.steps.length === 1 ? '' : 's'} ${update.steps.join(', ')}.`;
      break;
    }
    case 'wait': {
      changed = await change({ action: 'wait', step: update.step });
      said = `You are told at your prompt once step ${update.step} is done. End your turn if you have nothing else to do.`;
      break;
    }
    case 'add': {
      const { steps } = await drafts(session, update.text);
      changed = await change({ action: 'add', steps });
      said = `Added ${steps.length} step${steps.length === 1 ? '' : 's'}.`;
      break;
    }
    case 'answer': {
      const parts: string[] = [];
      if (update.step !== undefined) {
        if (update.answer === undefined) throw new BoardError('give the answer after the step number');
        changed = await change({ action: 'answer', step: update.step, answer: answerFrom(stepAt(stepsOf(item), update.step), update.answer) });
        parts.push(`Answered step ${update.step}.`);
      } else if (update.send !== true) throw new BoardError('give the step number and its answer, or --send to send the answers');
      if (update.send === true) {
        changed = await change({ action: 'send' });
        const maker = stepsOf(changed).madeBy;
        parts.push(`Sent the answers to ${maker.kind === 'agent' ? maker.name : 'its maker'}.`);
      }
      said = parts.join(' ');
      break;
    }
    case 'close': {
      changed = await change({ action: 'close' });
      said = 'Closed it: it stays on the board, done, until the user takes it off.';
      break;
    }
  }
  return { text: `${said}\n${cardText(refs, changed)}`, json: changed };
}
