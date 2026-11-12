const readline = require('node:readline');
const mode = process.argv[2];
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
let promptId;
let authenticated = false;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === 99) {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify({ permission: message.result, authenticated }) } } } });
    send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
  } else if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [{ id: 'login', name: 'Login' }] } });
  } else if (message.method === 'authenticate') {
    authenticated = true;
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'authenticate was called' } });
  } else if (message.method === 'session/new') {
    if (mode === 'auth') send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: authenticated ? 'authenticate was called' : 'Authentication required' } });
    else send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 's' } });
  } else if (message.method === 'session/prompt') {
    if (mode === 'disconnect') return process.exit(0);
    promptId = message.id;
    if (mode === 'args') send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: process.argv[3] } } } });
    for (const [kind, text] of [['agent_thought_chunk', 'SECRET'], ['agent_message_chunk', 'hello']]) {
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: kind, content: { type: 'text', text } } } });
    }
    send({ jsonrpc: '2.0', id: 99, method: 'session/request_permission', params: { sessionId: 's', toolCall: { toolCallId: 't', title: mode === 'long' ? 'x'.repeat(4000) : 'write' }, options: mode === 'long' ? Array.from({length: 30}, (_, i) => ({ optionId: String(i), name: 'y'.repeat(4000), kind: 'allow_once' })) : [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }] } });
  }
});
