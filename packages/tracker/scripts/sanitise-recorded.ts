// Sanitises the recorded Linear fixtures in place (see sanitise-linear.ts), for a recording made before the recorder did:
//
//   pnpm --filter @agent-board/tracker sanitise:linear
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sanitiseRecording, type LinearRecording } from './sanitise-linear.ts';

const file = fileURLToPath(new URL('../fixtures/linear/recorded.json', import.meta.url));
const recording = sanitiseRecording(JSON.parse(readFileSync(file, 'utf8')) as LinearRecording);
writeFileSync(file, `${JSON.stringify(recording, null, 2)}\n`);
console.log(`sanitised ${file}`);
