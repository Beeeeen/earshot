/**
 * A TEST DOUBLE, not part of the demo.
 * ====================================
 * This is a minimal MCP server over Streamable HTTP whose only job is to prove
 * that demo/adapter.js really speaks the protocol -- handshake, session id, SSE
 * framing, tools/list, tools/call -- before src/ exists. Nothing in demo/ loads
 * it and it is never running during a recording.
 *
 *   node demo/tools/mock-mcp.mjs [--port 8787]
 *   node demo/tools/verify-live.mjs        # starts this, drives the demo at it
 *
 * Its data is deliberately DIFFERENT from the fixtures in scenario.js -- a
 * different patient, a different drug -- so that when the demo is pointed at it
 * you can see at a glance that the words on screen came over the wire and not
 * out of the page.
 *
 * Two things here that the real server also has to do, and that are easy to
 * miss until a browser is pointed at it:
 *
 *   1. CORS, including `Access-Control-Expose-Headers: Mcp-Session-Id`. Without
 *      that last one the browser can complete the handshake and then silently
 *      fail every subsequent call, because it cannot read the session id it is
 *      required to echo back.
 *   2. An OPTIONS preflight, which a POST carrying Content-Type: application/json
 *      plus MCP-Protocol-Version will always trigger.
 *
 * It answers tools/call as text/event-stream and everything else as plain JSON,
 * so both response shapes in the spec get exercised.
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const PROTOCOL = '2025-11-25';
const argv = process.argv.slice(2);
const PORT = Number(argv[argv.indexOf('--port') + 1] || 8791);

/* The values this server considers protected. It ships them to the client so
   the client can verify the spoken channel against the server's own list
   rather than against a list the demo made up. */
const PROTECTED = [
  { label: 'Medication name', value: 'Apixaban', alts: [] },
  { label: 'Dose', value: '5 mg', alts: ['5mg', '5 milligrams'] },
  { label: 'Diagnosis', value: 'Atrial fibrillation', alts: ['AFib', 'A-fib'] },
  { label: 'Prescriber', value: 'Dr. K. Okonjo', alts: ['Okonjo'] },
];

const TOOLS = [
  ['check_adherence', 'Whether today’s doses were taken, and when.'],
  ['next_dose', 'When the next dose is due.'],
  ['log_dose', 'Record that a dose was taken.'],
  ['report_symptom', 'Log a symptom and notify whoever has a grant.'],
  ['care_summary', 'Full summary, for holders of a grant. Private channel only.'],
  ['who_can_see', 'Who currently holds a grant on this person.'],
  ['open_solo_window', 'Caller declares they are alone. Five minutes.'],
  ['disclosure_ledger', 'What was spoken, what was shifted, what was refused.'],
].map(([name, description]) => ({
  name,
  description,
  inputSchema: { type: 'object', properties: { subject: { type: 'string' } } },
}));

/* Set MOCK_LEAK=1 and this server starts putting a protected value into the
   spoken string. Nothing in the demo special-cases it: the counter goes to 1,
   the search box lights up red and the page throws a full-screen breach. That
   is the point -- demo/tools/verify-live.mjs runs a pass with it on, because an
   invariant check that has never once fired is not a check. */
const LEAK = process.env.MOCK_LEAK === '1';

const RESULTS = {
  check_adherence: (args) => (args && args.speak_detail
    ? {
        spoken: 'Not in the room. It’s on your phone.',
        tier: 'private',
        refused: { reason: 'The spoken field is built from spoken-tier data only.' },
        private: null,
        disclosures: [
          { state: 'refused', what: 'Medication name, for the room', detail: 'no such code path' },
        ],
      }
    : {
        spoken: LEAK
          ? 'Taken, 7:52 this morning. That is her Apixaban, 5 mg.'
          : 'Taken, 7:52 this morning, twelve minutes early. One detail is on your phone.',
        tier: 'private',
        private: {
          title: 'This morning’s dose',
          source: 'check_adherence (mock)',
          rows: [
            { k: 'Medication', v: 'Apixaban', hero: true },
            { k: 'Dose', v: '5 mg, oral' },
            { k: 'Taken', v: '07:52 — 12 minutes early' },
            { k: 'For', v: 'Atrial fibrillation' },
            { k: 'Prescriber', v: 'Dr. K. Okonjo' },
          ],
        },
        disclosures: [
          { state: 'spoken', what: 'Adherence and time', detail: 'taken, 7:52' },
          { state: 'shifted', what: 'Medication, dose, indication', detail: '→ linked device' },
        ],
      }),
  who_can_see: () => ({
    spoken: 'Two people right now — you and the district nurse. Hers lapses on Sunday.',
    tier: 'spoken', private: null,
  }),
  report_symptom: () => ({
    spoken: 'Logged. I’ve told the nurse line. The detail is on your phone.',
    tier: 'private',
    private: {
      title: 'Symptom logged', source: 'report_symptom (mock)',
      rows: [
        { k: 'Symptom', v: 'Bruising on forearms', hero: true },
        { k: 'May relate to', v: '5 mg Apixaban — anticoagulant' },
      ],
    },
  }),
  care_summary: () => ({
    spoken: 'That one stays in the app.',
    tier: 'sealed',
    private: {
      title: 'Full care record', source: 'care_summary (mock)', tier: 'sealed',
      rows: [{ k: 'Record', v: '•••• •••••••', masked: true }],
      action: 'Open in Earshot',
    },
  }),
  open_solo_window: () => ({
    spoken: 'Solo window open for five minutes. Logged.', tier: 'spoken', private: null,
  }),
};

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version',
  // Without this the browser can never read the session id it must echo back.
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
  'Access-Control-Max-Age': '600',
};

const sessions = new Set();

createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors).end(); return; }
  if (!req.url.startsWith('/mcp')) { res.writeHead(404, cors).end(); return; }

  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let msg;
    try { msg = JSON.parse(body || '{}'); } catch { msg = {}; }
    const { id, method, params } = msg;

    if (method === 'initialize') {
      const sid = randomUUID();
      sessions.add(sid);
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json', 'Mcp-Session-Id': sid });
      res.end(JSON.stringify({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'earshot-mock', version: '0.0.0-test-double' },
        },
      }));
      return;
    }

    if (method && method.startsWith('notifications/')) {
      res.writeHead(202, cors).end();
      return;
    }

    if (method === 'tools/list') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { tools: TOOLS } }));
      return;
    }

    if (method === 'tools/call') {
      const make = RESULTS[params && params.name];
      const payload = make ? make(params.arguments) : {
        spoken: 'The mock has nothing scripted for ' + (params && params.name) + '.',
        tier: 'spoken', private: null,
      };
      payload.protected = PROTECTED;
      // Answered as an SSE stream, which is the other half of Streamable HTTP.
      res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write('event: message\n');
      res.write('data: ' + JSON.stringify({
        jsonrpc: '2.0', id,
        result: {
          content: [{ type: 'text', text: payload.spoken }],
          structuredContent: payload,
        },
      }) + '\n\n');
      res.end();
      return;
    }

    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method },
    }));
  });
}).listen(PORT, () => {
  console.log(`mock MCP (test double) on http://localhost:${PORT}/mcp`);
  console.log(`  protocol ${PROTOCOL} · ${TOOLS.length} tools · tools/call answers as SSE`);
});
