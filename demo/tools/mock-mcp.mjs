/**
 * A TEST DOUBLE, not part of the demo.
 * ====================================
 * A minimal Earshot-shaped server whose only job is to prove that
 * demo/adapter.js really speaks the protocol. Nothing in demo/ loads it and it
 * is never running during a recording.
 *
 *   node demo/tools/mock-mcp.mjs [--port 8791]
 *   node demo/tools/verify-live.mjs        # starts this, drives the demo at it
 *
 * It mirrors the real contract from src/protocol/envelope.ts and
 * src/protocol/private-channel.ts, because a double that answers a shape the
 * real server does not produce tests nothing:
 *
 *   POST /mcp   -> structuredContent { spoken, channel, privateDelivery|null,
 *                  notifiedOthers, sealedPointers, underSoloWindow,
 *                  serverLatencyMs, data, note }
 *   GET  /inbox -> { deliveries: [{ id, tool, title, fields:[{label,value}],
 *                    sealed, footnote }] }
 *
 * The private payload is on /inbox and NOWHERE in the MCP response, exactly as
 * upstream. Two things it also does that the real server has to:
 *
 *   1. CORS including `Access-Control-Expose-Headers: Mcp-Session-Id`, without
 *      which a browser completes the handshake and then silently fails every
 *      call, because it cannot read the session id it must echo back.
 *   2. The OPTIONS preflight that a POST with Content-Type: application/json
 *      plus MCP-Protocol-Version always triggers.
 *
 * It answers tools/call as text/event-stream and everything else as plain
 * JSON, so both Streamable HTTP response shapes get exercised. It has no OAuth
 * server, which is also deliberate: that checks the demo degrades to an
 * unauthenticated handshake instead of giving up.
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const PROTOCOL = '2025-11-25';
const argv = process.argv.slice(2);
const PORT = Number(argv[argv.indexOf('--port') + 1] || 8791);

/* Set MOCK_LEAK=1 and this server starts putting a protected value into the
   spoken string. Nothing in the demo special-cases it: the counter moves off
   zero, the search box goes red and the page throws a full-screen breach.
   verify-live.mjs runs a pass with it on, because an invariant check that has
   never once fired is not a check. */
const LEAK = process.env.MOCK_LEAK === '1';

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
  name, description,
  inputSchema: { type: 'object', properties: { subject: { type: 'string' } } },
}));

/** Deliveries live here and are served by /inbox. Never by /mcp. */
const deliveries = [];
let seq = 0;

function deliver(tool, title, fields) {
  const d = {
    id: 'deliv_' + (++seq),
    createdAt: new Date().toISOString(),
    tool, title, subject: 'Margaret Chen',
    fields, sealed: [], footnote: null, wasRead: false,
  };
  deliveries.push(d);
  return {
    deliveryId: d.id, fieldCount: fields.length,
    recipient: 'Sarah Chen', channel: 'linked-device',
  };
}

const NOTE_PRIVATE =
  'The detail is not in this response. It was sent to the asker’s own device. ' +
  'Say only the `spoken` field.';

/* Each returns the structuredContent the real envelope would produce. Values
   come from the same household src/domain/seed.ts seeds, so /secrets and this
   double are talking about the same person. */
const RESULTS = {
  check_adherence: () => {
    const receipt = deliver('check_adherence', 'This morning’s doses', [
      { label: 'Medication', value: 'Apixaban 5 mg — taken 8:07 AM' },
      { label: 'For', value: 'stroke prevention in atrial fibrillation' },
      { label: 'Prescriber', value: 'Dr. Alan Whitfield' },
    ]);
    return {
      spoken: LEAK
        ? 'Taken, 7:52 this morning. That is her Apixaban, 5 mg.'
        : 'Taken, 7:52 this morning, twelve minutes early. One detail is on your phone.',
      channel: 'spoken+private-delivery',
      privateDelivery: receipt, notifiedOthers: [], sealedPointers: [],
      underSoloWindow: false, data: { onTime: true }, note: NOTE_PRIVATE,
    };
  },
  who_can_see: () => ({
    spoken: 'Two people right now — you and the district nurse. Hers lapses on Sunday.',
    channel: 'spoken-only', privateDelivery: null, notifiedOthers: [],
    sealedPointers: [], underSoloWindow: false, data: { count: 2 }, note: null,
  }),
  report_symptom: () => {
    const receipt = deliver('report_symptom', 'Symptom logged', [
      { label: 'Symptom', value: 'Bruising on forearms' },
      { label: 'May relate to', value: 'Apixaban 5 mg — anticoagulant' },
    ]);
    return {
      spoken: 'Logged. I’ve told the nurse line. The detail is on your phone.',
      channel: 'spoken+private-delivery', privateDelivery: receipt,
      notifiedOthers: [{ recipient: 'Daniel Chen', deliveryId: 'deliv_n', fieldCount: 2 }],
      sealedPointers: [], underSoloWindow: false, data: null, note: NOTE_PRIVATE,
    };
  },
  care_summary: () => ({
    spoken: 'That one stays in the app.',
    channel: 'spoken+app-pointer', privateDelivery: null, notifiedOthers: [],
    sealedPointers: [{ label: 'Full cardiology chart', appPath: '/chart' }],
    underSoloWindow: false, data: null, note: 'Say only the `spoken` field.',
  }),
  open_solo_window: (args) => ({
    spoken: args && args.close
      ? 'Solo window closed. Back to assuming the room is full.'
      : 'Solo window open for five minutes. Logged.',
    channel: 'spoken-only', privateDelivery: null, notifiedOthers: [],
    sealedPointers: [], underSoloWindow: false, data: null, note: null,
  }),
};

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
  'Access-Control-Max-Age': '600',
};

createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors).end(); return; }

  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/inbox') {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      recipient: 'Sarah Chen', count: deliveries.length, deliveries,
    }));
    return;
  }

  if (!url.pathname.startsWith('/mcp')) { res.writeHead(404, cors).end(); return; }

  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let msg;
    try { msg = JSON.parse(body || '{}'); } catch { msg = {}; }
    const { id, method, params } = msg;

    if (method === 'initialize') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json',
                           'Mcp-Session-Id': randomUUID() });
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

    if (method && method.startsWith('notifications/')) { res.writeHead(202, cors).end(); return; }

    if (method === 'tools/list') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { tools: TOOLS } }));
      return;
    }

    if (method === 'tools/call') {
      const t0 = performance.now();
      const make = RESULTS[params && params.name];
      const payload = make ? make(params && params.arguments) : {
        spoken: 'The mock has nothing scripted for ' + (params && params.name) + '.',
        channel: 'spoken-only', privateDelivery: null, notifiedOthers: [],
        sealedPointers: [], underSoloWindow: false, data: null, note: null,
      };
      payload.serverLatencyMs = Math.round((performance.now() - t0) * 100) / 100;
      res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream',
                           'Cache-Control': 'no-cache' });
      res.write('event: message\n');
      res.write('data: ' + JSON.stringify({
        jsonrpc: '2.0', id,
        result: {
          content: [{ type: 'text', text: payload.spoken }],
          structuredContent: payload,
          _meta: { 'earshot/serverLatencyMs': payload.serverLatencyMs },
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
  console.log(`  protocol ${PROTOCOL} · ${TOOLS.length} tools · SSE tools/call · /inbox second channel`);
  if (LEAK) console.log('  MOCK_LEAK=1 — deliberately speaking a protected value');
});
