import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  checkAgentLaunchSettings,
  launchSettingKeys,
  launchSettingsParam,
  parseEnvPairs,
  heldLaunchSettings,
  keepLaunchSettingNamesOnly,
  launchSettingNames,
  launchSettingNamesColumn,
  withOwnSettings,
} from './launch-settings.ts';

describe('launchSettingsParam', () => {
  it('takes env vars and Claude settings', () => {
    expect(launchSettingsParam({ env: { CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '0' }, settings: { outputStyle: 'Explanatory' } }, 'claude')).toEqual({
      env: { CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '0' },
      settings: { outputStyle: 'Explanatory' },
    });
  });

  it('reads nothing given as none, and empty parts as empty', () => {
    expect(launchSettingsParam(undefined, 'claude')).toBeUndefined();
    expect(launchSettingsParam({}, 'claude')).toEqual({});
    expect(launchSettingsParam({ env: {}, settings: {} }, 'claude')).toEqual({});
  });

  it('refuses env names that are not names, and values that are not strings', () => {
    expect(() => launchSettingsParam({ env: { 'A-B': '1' } }, 'claude')).toThrow(/A-B/);
    expect(() => launchSettingsParam({ env: { '': '1' } }, 'claude')).toThrow(/name/);
    expect(() => launchSettingsParam({ env: { A: 1 } }, 'claude')).toThrow(/string/);
    expect(() => launchSettingsParam({ env: { A: 'x\x00y' } }, 'claude')).toThrow(/NUL/);
    expect(() => launchSettingsParam({ env: ['A=1'] }, 'claude')).toThrow(/object/);
  });

  it("refuses the board's own env, which would cut the agent off from the board", () => {
    expect(() => launchSettingsParam({ env: { AGENT_BOARD_SOCKET: '/tmp/s' } }, 'claude')).toThrow(/AGENT_BOARD_/);
    expect(() => launchSettingsParam({ env: { agent_board_token: 'x' } }, 'claude')).toThrow(/AGENT_BOARD_/);
    expect(() => launchSettingsParam({ env: { CLAUDECODE: '1' } }, 'claude')).toThrow(/CLAUDECODE/);
  });

  it("refuses settings that would turn off the board's hooks or status line", () => {
    for (const key of ['hooks', 'statusLine', 'disableAllHooks', 'allowManagedHooksOnly']) {
      expect(() => launchSettingsParam({ settings: { [key]: {} } }, 'claude')).toThrow(new RegExp(key));
    }
  });

  it('refuses permission settings, which an agent starting another must never loosen', () => {
    expect(() => launchSettingsParam({ settings: { permissions: { defaultMode: 'bypassPermissions' } } }, 'claude')).toThrow(/permission/);
    expect(() => launchSettingsParam({ settings: { skipDangerousModePermissionPrompt: true } }, 'claude')).toThrow(/permission/);
  });

  it('refuses settings that are not an object, and env in settings that breaks the env rules', () => {
    expect(() => launchSettingsParam({ settings: [] }, 'claude')).toThrow(/object/);
    expect(() => launchSettingsParam({ settings: { env: { AGENT_BOARD_URL: 'x' } } }, 'claude')).toThrow(/AGENT_BOARD_/);
    expect(() => launchSettingsParam({ settings: { env: 'x' } }, 'claude')).toThrow(/object/);
  });

  it('gives Codex env vars, never Claude settings', () => {
    expect(launchSettingsParam({ env: { A: '1' } }, 'codex')).toEqual({ env: { A: '1' } });
    expect(() => launchSettingsParam({ settings: { model: 'opus' } }, 'codex')).toThrow(/Codex/);
  });

  it('refuses unknown parts and launch settings past their size', () => {
    expect(() => launchSettingsParam({ args: ['--x'] }, 'claude')).toThrow(/args/);
    expect(() => launchSettingsParam({ env: { A: 'x'.repeat(20_000) } }, 'claude')).toThrow(/long/);
  });
});

describe('settings the board passes as flags', () => {
  it('refuses model and effortLevel, which --model and --effort beat', () => {
    expect(() => launchSettingsParam({ settings: { model: 'sonnet' } }, 'claude')).toThrow(/--model/);
    expect(() => launchSettingsParam({ settings: { effortLevel: 'high' } }, 'claude')).toThrow(/--effort/);
  });
});

describe('checkAgentLaunchSettings', () => {
  it('lets an agent set plain knobs and the named switches', () => {
    expect(() =>
      checkAgentLaunchSettings({
        env: { CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '0', MAX_THINKING_TOKENS: '8000', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' },
        settings: { outputStyle: 'Explanatory', alwaysThinkingEnabled: true, env: { MCP_TIMEOUT: '5000' } },
      }),
    ).not.toThrow();
    expect(() => checkAgentLaunchSettings(undefined)).not.toThrow();
  });

  it('refuses a DISABLE_ name off the list from an agent, which the app still takes', () => {
    for (const name of ['DISABLE_COST_WARNINGS', 'CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING']) {
      expect(() => checkAgentLaunchSettings({ env: { [name]: '1' } }), name).toThrow(`${name} is not one an agent may set`);
      expect(() => checkAgentLaunchSettings({ settings: { env: { [name]: '1' } } }), name).toThrow(`${name} is not one an agent may set`);
      expect(launchSettingsParam({ env: { [name]: '1' } }, 'claude'), name).toEqual({ env: { [name]: '1' } });
    }
  });

  it('refuses env vars that load code, move the harness or its shell, or send it elsewhere', () => {
    for (const name of ['ZDOTDIR', 'BASH_ENV', 'ENV', 'NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES', 'PATH', 'HOME', 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_SHELL_PREFIX', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY']) {
      expect(() => checkAgentLaunchSettings({ env: { [name]: 'x' } }), name).toThrow(`${name} is not one an agent may set`);
      expect(() => checkAgentLaunchSettings({ settings: { env: { [name]: 'x' } } }), name).toThrow(`${name} is not one an agent may set`);
    }
  });

  it('refuses settings that run a command or load servers and plugins', () => {
    for (const key of ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper', 'fileSuggestion', 'enableAllProjectMcpServers', 'enabledMcpjsonServers', 'enabledPlugins', 'extraKnownMarketplaces']) {
      expect(() => checkAgentLaunchSettings({ settings: { [key]: 'x' } }), key).toThrow(`${key} is not one an agent may set`);
    }
  });
});

describe('parseEnvPairs', () => {
  it('reads KEY=VALUE, the value kept whole after the first =', () => {
    expect(parseEnvPairs(['A=1', 'B=x=y', 'C='])).toEqual({ A: '1', B: 'x=y', C: '' });
  });

  it('reads an empty pair as none, as a restart clears its env with', () => {
    expect(parseEnvPairs([''])).toEqual({});
  });

  it('refuses a pair with no name or no =', () => {
    expect(() => parseEnvPairs(['A'])).toThrow(/KEY=VALUE/);
    expect(() => parseEnvPairs(['=1'])).toThrow(/KEY=VALUE/);
  });
});

describe('the launch settings column', () => {
  const settings = { env: { A: 'secret-a' }, settings: { model: 'opus' } };

  it('keeps names only, none as null', () => {
    const column = launchSettingNamesColumn(settings);
    expect(column).not.toContain('secret-a');
    expect(launchSettingNames(column)).toEqual({ env: ['A'], settings: ['model'] });
    expect(heldLaunchSettings(column)).toBeUndefined();
    expect(launchSettingNamesColumn(undefined)).toBeNull();
    expect(launchSettingNamesColumn({})).toBeNull();
    expect(launchSettingNamesColumn({ env: {} })).toBeNull();
    expect(launchSettingNames(null)).toBeNull();
  });

  it("reads an older build's values, and their names", () => {
    const column = JSON.stringify(settings);
    expect(heldLaunchSettings(column)).toEqual(settings);
    expect(launchSettingNames(column)).toEqual({ env: ['A'], settings: ['model'] });
  });

  it('reads a damaged column as none', () => {
    for (const column of ['{not json', '[1]', null]) {
      expect(heldLaunchSettings(column)).toBeUndefined();
      expect(launchSettingNames(column)).toBeNull();
    }
  });

  it('rewrites the values in a database to their names', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE agents (session_id TEXT, launch_settings TEXT)');
    const insert = db.prepare('INSERT INTO agents VALUES (?, ?)');
    insert.run('held', JSON.stringify(settings));
    insert.run('named', launchSettingNamesColumn(settings));
    insert.run('none', null);
    expect(keepLaunchSettingNamesOnly(db)).toBe(1);
    const rows = db.prepare('SELECT session_id, launch_settings FROM agents ORDER BY session_id').all();
    expect(JSON.stringify(rows)).not.toContain('secret-a');
    expect(launchSettingNames((rows[0] as { launch_settings: string }).launch_settings)).toEqual({ env: ['A'], settings: ['model'] });
    expect(keepLaunchSettingNamesOnly(db)).toBe(0);
    expect(keepLaunchSettingNamesOnly(new DatabaseSync(':memory:'))).toBe(0);
  });
});

describe('withOwnSettings', () => {
  const base = { statusLine: { type: 'command', command: 'x' }, hooks: { Stop: [] } };

  it("adds the agent's settings to the board's, and its env vars to the settings' env block", () => {
    expect(withOwnSettings(base, { env: { A: '1' }, settings: { model: 'opus', env: { A: '0', B: '2' } } })).toEqual({
      ...base,
      model: 'opus',
      env: { A: '1', B: '2' },
    });
  });

  it("leaves the board's settings alone with none", () => {
    expect(withOwnSettings(base, undefined)).toBe(base);
    expect(withOwnSettings(base, {})).toEqual(base);
  });
});

describe('launchSettingKeys', () => {
  it('shows only the names, never the values', () => {
    expect(launchSettingKeys({ env: { TOKEN: 'secret' }, settings: { model: 'opus', env: { B: 'b' } } })).toEqual({ env: ['TOKEN'], settings: ['model', 'env'] });
    expect(launchSettingKeys(undefined)).toBeNull();
    expect(launchSettingKeys({})).toBeNull();
  });
});
