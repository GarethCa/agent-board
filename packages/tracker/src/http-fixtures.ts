import { isDeepStrictEqual } from 'node:util';

/**
 * One recorded HTTP exchange. Request headers are never recorded: they carry the credential. A JSON body is kept
 * parsed, with a GraphQL `query`'s whitespace collapsed, so fixtures stay readable and diffable.
 */
export interface HttpInteraction {
  request: { method: string; url: string; body?: unknown };
  response: { status: number; body: unknown };
}

/** A `fetch` that answers from `interactions` and never touches the network. */
export interface ReplayFetch {
  fetch: typeof fetch;
  /** The interactions no request has matched yet. */
  unused(): HttpInteraction[];
}

/**
 * Replays recorded interactions: each request gets the response of the first interaction with the same method, URL
 * and body, and an unmatched request throws, naming it. An interaction can answer any number of times.
 */
export function replayFetch(interactions: readonly HttpInteraction[]): ReplayFetch {
  const used = new Set<HttpInteraction>();
  const replay = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = await recordedRequest(input, init);
    const match = interactions.find((interaction) => sameRequest(interaction.request, request));
    if (match === undefined) throw new Error(`no recorded HTTP fixture for ${JSON.stringify(request)}`);
    used.add(match);
    return Response.json(match.response.body, { status: match.response.status });
  };
  return {
    fetch: replay as typeof fetch,
    unused: () => interactions.filter((interaction) => !used.has(interaction)),
  };
}

/** Wraps a real `fetch`, calling `record` with every exchange it makes (without headers). */
export function recordingFetch(real: typeof fetch, record: (interaction: HttpInteraction) => void): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = await recordedRequest(input, init);
    const response = await real(input, init);
    const text = await response.clone().text();
    record({ request, response: { status: response.status, body: parseJson(text) } });
    return response;
  }) as typeof fetch;
}

/** A request as fixtures store it. */
async function recordedRequest(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<HttpInteraction['request']> {
  const request = new Request(input, init);
  const text = await request.text();
  const body = text === '' ? undefined : normalizeBody(parseJson(text));
  return { method: request.method, url: request.url, ...(body === undefined ? {} : { body }) };
}

function sameRequest(recorded: HttpInteraction['request'], actual: HttpInteraction['request']): boolean {
  return (
    recorded.method === actual.method &&
    recorded.url === actual.url &&
    isDeepStrictEqual(normalizeBody(recorded.body), actual.body)
  );
}

function normalizeBody(body: unknown): unknown {
  if (typeof body !== 'object' || body === null || !('query' in body) || typeof body.query !== 'string') return body;
  return { ...body, query: body.query.replace(/\s+/g, ' ').trim() };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
