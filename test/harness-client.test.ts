import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { AcpClient, type HarnessProgress } from '../src/public-api.js';

const agent = fileURLToPath(new URL('./fixtures/harness-agent.cjs', import.meta.url));
function client(mode = '', progress: HarnessProgress[] = []) {
  return new AcpClient({ agentName: 'fixture', config: { command: 'node', args: [agent, mode] }, harness: { onProgress: (event) => progress.push(event) } });
}

describe('harness ACP client', () => {
  it('exposes handshake, denies permission, keeps thoughts out of final text, and never authenticates', async () => {
    const events: HarnessProgress[] = [];
    const c = client('', events);
    try {
      await c.connect();
      const init = await c.initialize();
      expect(init.authMethods?.[0]?.id).toBe('login');
      expect(c.agentInfo?.agentCapabilities?.loadSession).toBe(true);
      await c.newSession();
      const result = await c.prompt('hi');
      expect(result.text).toBe('hello' + JSON.stringify({ permission: { outcome: { outcome: 'cancelled' } }, authenticated: false }));
      expect(events).toContainEqual(expect.objectContaining({ type: 'permission', title: 'write' }));
      expect(events).toContainEqual(expect.objectContaining({ type: 'update', updateType: 'agent_thought_chunk' }));
      expect(JSON.stringify(events)).not.toContain('SECRET');
    } finally { await c.dispose(); }
  });
  it('surfaces an authentication-required error rather than authenticating', async () => {
    const c = client('auth');
    try {
      await c.connect(); await c.initialize();
      await expect(c.newSession()).rejects.toMatchObject({ message: expect.stringMatching(/authentication required/i), code: -32000 });
    } finally { await c.dispose(); }
  });
  it('bounds each permission notification even for oversized server input', async () => {
    const events: HarnessProgress[] = [];
    const c = client('long', events);
    try {
      await c.connect(); await c.initialize(); await c.newSession(); await c.prompt('hi');
      const permission = events.find(event => event.type === 'permission');
      expect(permission?.type).toBe('permission');
      if (permission?.type !== 'permission') throw new Error('missing permission');
      expect(permission.title).toHaveLength(256);
      expect(permission.options).toHaveLength(16);
      expect(permission.options[0]?.name).toHaveLength(256);
      expect(permission.omittedOptions).toBe(14);
      expect(permission.outcome).toBe('cancelled');
    } finally { await c.dispose(); }
  });
  it('preserves legacy auto-authentication, approval, and thought text without opt-in', async () => {
    const c = new AcpClient({ agentName: 'legacy', config: { command: 'node', args: [agent] } });
    try {
      await c.connect(); await c.initialize(); await c.newSession();
      const result = await c.prompt('hi');
      expect(result.text).toContain('SECREThello');
      expect(result.text).toContain('"authenticated":true');
      expect(result.text).toContain('"optionId":"yes"');
    } finally { await c.dispose(); }
  });
  it('passes spaces and shell metacharacters literally to the native executable', async () => {
    const argument = 'space & echo INJECTED | more > output %PATH%';
    const c = new AcpClient({ agentName: 'args', config: { command: process.execPath, args: [agent, 'args', argument] }, harness: {} });
    try {
      await c.connect(); await c.initialize(); await c.newSession();
      expect((await c.prompt('hi')).text.startsWith(argument + 'hello')).toBe(true);
    } finally { await c.dispose(); }
  });
  it('fails explicitly for a command that is not executable', async () => {
    const c = new AcpClient({ agentName: 'missing', config: { command: 'pi-acp-no-such-executable-43873', args: [] }, harness: {} });
    try {
      await expect(c.connect().then(() => c.initialize())).rejects.toThrow(/spawn|ENOENT|not found/i);
    } finally { await c.dispose(); }
  });
  it.skipIf(process.platform !== 'win32')('rejects a Windows command wrapper without running a shell', async () => {
    const wrapper = fileURLToPath(new URL('./fixtures/not-native.cmd', import.meta.url));
    const c = new AcpClient({ agentName: 'wrapper', config: { command: wrapper, args: [] }, harness: {} });
    try {
      await expect(c.connect().then(() => c.initialize())).rejects.toThrow(/spawn|EINVAL|ENOENT/i);
    } finally { await c.dispose(); }
  });
  it('surfaces disconnect during prompt', async () => {
    const c = client('disconnect');
    try {
      await c.connect(); await c.initialize(); await c.newSession();
      await expect(c.prompt('hi')).rejects.toThrow();
    } finally { await c.dispose(); }
  }, 5000);
});
