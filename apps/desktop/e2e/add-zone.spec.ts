import { expect } from '@playwright/test';
import { createFakeGitHub, createTempKeychain, FAKE_GITHUB_STATE } from '@agent-board/tracker/testing';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { agents, launch, LINEAR_API_KEY, serveLinearFixtures, zoneNamed, zones } from './agent-helpers.ts';
import { browseForZone, openAddZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

test('a zone from a GitHub repo clones it into the managed folder, with New agent blocked until it is done; a cancelled or failed clone leaves no zone', async () => {
  const { dir, repo, env } = scratch('waiting');
  const reposDir = join(dir, 'repos');
  // acme/app clones from the scratch repo, slowly enough to watch; acme/ops has nothing to clone from, so it fails.
  const github = createFakeGitHub({
    ...FAKE_GITHUB_STATE,
    repos: [
      { nameWithOwner: 'acme/app', description: 'The app', cloneFrom: repo },
      { nameWithOwner: 'acme/ops', description: null },
    ],
    cloneDelayMs: 5_000,
  });
  const dataDir = tempDataDir();
  const { app: electronApp, window } = await launch(dataDir, { ...env, AGENT_BOARD_GH: github.gh, AGENT_BOARD_REPOS_DIR: reposDir });
  try {
    // The repos gh sees, each saying where it would clone to: no OS folder picker.
    let popover = await openAddZone(window, 'GitHub');
    const app = popover.getByRole('option').filter({ hasText: 'The app' });
    await expect(app).toContainText(`will clone to ${join(reposDir, 'acme', 'app')}`);
    await app.click();
    await expect(popover.getByRole('textbox', { name: 'Zone name' })).toHaveValue('app');
    await expect(popover.getByRole('button', { name: /^Clone and add/ })).toBeEnabled();
    await window.screenshot({ path: test.info().outputPath('add-zone-github.png'), animations: 'disabled' });
    await popover.getByRole('button', { name: /^Clone and add/ }).click();
    await expect(popover).toBeHidden();

    // While it clones: its progress on its tab, and no agents (S2).
    const zone = zoneNamed(window, 'app');
    await expect(zone.getByTestId('zone-clone')).toBeVisible();
    const newAgent = zone.getByRole('button', { name: 'New agent' });
    await expect(newAgent).toHaveAttribute('aria-disabled', 'true');
    await expect(newAgent).toHaveAttribute('title', 'Available after clone finishes');
    await window.screenshot({ path: test.info().outputPath('cloning.png'), animations: 'disabled' });

    // Then it is a repo zone of the clone, its issues from the repo on GitHub.
    await expect(zone).toHaveAttribute('data-kind', 'repo', { timeout: 20_000 });
    await expect(zone.getByTestId('zone-clone')).toHaveCount(0);
    await expect(newAgent).toHaveAttribute('aria-disabled', 'false');
    const [cloned] = await zones(window);
    expect(cloned).toMatchObject({ repoRoot: join(reposDir, 'acme', 'app'), tracker: { provider: 'github', scope: 'acme/app' } });
    expect(existsSync(join(reposDir, 'acme', 'app', 'apps', 'web', 'index.ts'))).toBe(true);
    // It is known now: offered as the clone it is, and as already on the board.
    popover = await openAddZone(window, 'GitHub');
    await expect(popover.getByRole('option').filter({ hasText: 'The app' })).toContainText('Already on the board');
    await window.keyboard.press('Escape');

    // A clone cancelled from the zone's tab takes its zone and folder with it.
    github.setState({
      ...FAKE_GITHUB_STATE,
      repos: [{ nameWithOwner: 'acme/web', description: 'The site', cloneFrom: repo }],
      cloneDelayMs: 60_000,
    });
    popover = await openAddZone(window, 'GitHub');
    await popover.getByRole('option').filter({ hasText: 'The site' }).click();
    await popover.getByRole('button', { name: /^Clone and add/ }).click();
    const web = zoneNamed(window, 'web');
    await expect(web.getByTestId('zone-clone')).toBeVisible();
    await web.getByRole('button', { name: 'Cancel clone' }).click();
    await expect(web).toHaveCount(0);
    expect((await zones(window)).map((z) => z.name)).toEqual(['app']);
    expect(existsSync(join(reposDir, 'acme', 'web'))).toBe(false);

    // A failed clone says why, and leaves no zone.
    github.setState({ ...FAKE_GITHUB_STATE, repos: [{ nameWithOwner: 'acme/ops', description: 'Ops' }] });
    popover = await openAddZone(window, 'GitHub');
    await popover.getByRole('option').filter({ hasText: 'Ops' }).click();
    await popover.getByRole('button', { name: /^Clone and add/ }).click();
    await expect(window.getByRole('alert').filter({ hasText: 'Could not clone acme/ops' })).toBeVisible();
    await expect(zoneNamed(window, 'ops')).toHaveCount(0);
    expect((await zones(window)).map((z) => z.name)).toEqual(['app']);
  } finally {
    await electronApp.close();
    await removeDataDir(dataDir);
    github.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a zone from a recent folder needs no picker; Browse… is the only way to it', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await expect(zoneNamed(window, 'monorepo')).toHaveAttribute('data-kind', 'repo');

    // The folder is recent now: a second zone of it, named for a part of the repo, comes straight from the list.
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = (() => {
        throw new Error('the OS picker was opened');
      }) as typeof dialog.showOpenDialog;
    });
    const popover = await openAddZone(window, 'Recent');
    const recent = popover.getByRole('option').filter({ hasText: repo });
    await expect(recent).toContainText('On the board');
    await recent.click();
    await popover.getByRole('textbox', { name: 'Zone name' }).fill('Monorepo, again');
    await popover.getByRole('button', { name: /^Add zone/ }).click();
    await expect(popover).toBeHidden();
    await expect(zoneNamed(window, 'Monorepo, again')).toHaveAttribute('data-kind', 'repo');
    expect((await zones(window)).map((z) => z.repoRoot)).toEqual([repo, repo]);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a zone from a Linear team presets its tracker; an issue picked from it starts an agent fed from its card by an "issue brief" edge', async () => {
  // The key goes to a throwaway keychain file, which only macOS has. Elsewhere the store is the user's own (the Secret
  // Service on Linux), which tests never touch.
  test.skip(process.platform !== 'darwin', 'needs a throwaway macOS keychain');
  const { subject, interactions, server: linear } = await serveLinearFixtures();
  const { scope, knownIssue } = subject;
  const teams = interactions.find((i) => JSON.stringify(i.request.body).includes('query Teams') && i.response.status === 200)!
    .response.body as { data: { teams: { nodes: { key: string; name: string }[] } } };
  const team = teams.data.teams.nodes.find((each) => each.key === scope)!;
  const keychain = createTempKeychain();
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, AGENT_BOARD_LINEAR_API_URL: linear.url, AGENT_BOARD_KEYCHAIN: keychain.path });
  try {
    // A folder used before, for the Linear zone to be bound to.
    await pickFolderNext(app, repo);
    await browseForZone(window);

    // The Linear tab asks for a key the first time, then lists the teams it sees.
    const popover = await openAddZone(window, 'Linear');
    await popover.getByRole('textbox', { name: 'Linear API key' }).fill(LINEAR_API_KEY);
    await popover.getByRole('button', { name: 'Connect Linear' }).click();
    await popover.getByRole('option').filter({ hasText: team.name }).click();
    await expect(popover.getByRole('textbox', { name: 'Zone name' })).toHaveValue(team.name);
    await popover.getByRole('combobox', { name: 'Bind to' }).selectOption(`folder:${repo}`);
    await window.screenshot({ path: test.info().outputPath('add-zone-linear.png'), animations: 'disabled' });
    await popover.getByRole('button', { name: /^Add zone/ }).click();
    await expect(popover).toBeHidden();

    // Its tracker is the team, from the start; nothing is imported: the zone starts empty.
    const zone = zoneNamed(window, team.name);
    await expect(zone.getByRole('button', { name: 'Zone tracker' })).toHaveText(scope);
    expect((await zones(window)).find((z) => z.name === team.name)).toMatchObject({ repoRoot: repo, tracker: { provider: 'linear', scope } });
    await expect(window.getByTestId('issue-card')).toHaveCount(0);

    // Its issues are picked one at a time, from its tab. A pick starts an agent: in a zone that can start one, the
    // picker offers no card on its own.
    await zone.getByRole('button', { name: 'Add issue' }).click();
    const picker = window.getByRole('dialog', { name: 'Add an issue' });
    await picker.getByRole('option').filter({ hasText: knownIssue.id }).click();
    await expect(picker.getByRole('button', { name: 'Add card' })).toHaveCount(0);
    await picker.getByRole('button', { name: 'Start agent' }).click();
    await expect(picker).toBeHidden();
    const newAgent = window.getByRole('dialog', { name: 'New agent' });
    await expect(newAgent.getByTestId('selected-issue')).toContainText(knownIssue.id);
    await newAgent.getByRole('button', { name: 'Start' }).click();
    await expect(newAgent).toBeHidden();

    // One pick ends with the issue's card in the zone, an agent linked to the issue, and the "issue brief" edge between.
    const card = window.getByTestId('issue-card').filter({ hasText: knownIssue.title });
    await expect(card).toHaveAttribute('data-zone', (await zones(window)).find((z) => z.name === team.name)!.id);
    // The edge is drawn once the agent's tile is on the board.
    await expect(window.getByTestId('agent-tile').filter({ hasText: knownIssue.id })).toBeVisible();
    await expect(window.getByTestId('brief-edge')).toHaveCount(1);
    await expect(card.getByRole('button', { name: 'Start agent' })).toHaveCount(0);
    const [agent] = (await agents(window)).filter((a) => a.issue !== null);
    expect(agent!.issue).toMatchObject({ provider: 'linear', id: knownIssue.id });
    await window.getByRole('button', { name: 'Fit View' }).click();
    await window.screenshot({ path: test.info().outputPath('issue-brief.png'), animations: 'disabled' });
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
    keychain.remove();
    await linear.close();
  }
});

test('a zone from a Linear project is named after it, and its issue picker lists only that project\'s issues; a pick starts an agent linked to the issue', async () => {
  test.skip(process.platform !== 'darwin', 'needs a throwaway macOS keychain');
  // The recording has one project and one issue, so the team's issues and the project's are the same. Give the team an
  // issue outside the project, which only a request that limits issues to the project leaves out.
  const { subject: recorded, interactions, server: linear } = await serveLinearFixtures((all) => {
    const teamIssues = all.find((i) => {
      const request = JSON.stringify(i.request.body);
      return request.includes('query Issues') && !request.includes('"project"') && i.response.status === 200;
    })!.response.body as { data: { issues: { nodes: Record<string, unknown>[] } } };
    const [known] = teamIssues.data.issues.nodes;
    teamIssues.data.issues.nodes.push({ ...known, id: 'outside-the-project', identifier: 'ACME-9999', title: 'Outside the project' });
  });
  const subject = recorded as typeof recorded & { project?: string };
  // Only a recording from real Linear can say what its project calls answer.
  test.skip(subject.project === undefined, 'the Linear fixtures have no project calls yet: run record:linear');
  const { scope, knownIssue } = subject;
  const body = (match: (request: string) => boolean) =>
    interactions.find((i) => match(JSON.stringify(i.request.body)) && i.response.status === 200)!.response.body as {
      data: Record<string, { nodes: Record<string, unknown>[] }>;
    };
  const teams = body((request) => request.includes('query Teams')).data.teams!.nodes as { key: string; name: string }[];
  const team = teams.find((each) => each.key === scope)!;
  const projects = body((request) => request.includes('query Projects') && request.includes('"status"')).data.projects!
    .nodes as { id: string; name: string }[];
  const project = projects.find((each) => each.id === subject.project)!;
  // What Linear says is in the project: the picker must show these and no others.
  const inProject = (
    body((request) => request.includes('issues(filter') && request.includes(`"project":{"id":{"eq":"${project.id}"}}`))
      .data.issues!.nodes as { identifier: string }[]
  ).map((issue) => issue.identifier);
  expect(inProject).toContain(knownIssue.id);
  const keychain = createTempKeychain();
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, AGENT_BOARD_LINEAR_API_URL: linear.url, AGENT_BOARD_KEYCHAIN: keychain.path });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);

    // Team, then project: the project's zone is named after it.
    const popover = await openAddZone(window, 'Linear');
    await popover.getByRole('textbox', { name: 'Linear API key' }).fill(LINEAR_API_KEY);
    await popover.getByRole('button', { name: 'Connect Linear' }).click();
    await popover.getByRole('option').filter({ hasText: team.name }).click();
    await expect(popover.getByRole('textbox', { name: 'Zone name' })).toHaveValue(team.name);
    const projectList = popover.getByRole('listbox', { name: `${team.name} projects` });
    await expect(projectList.getByRole('option').first()).toContainText('Whole team');
    await projectList.getByRole('option').filter({ hasText: project.name }).click();
    await expect(popover.getByRole('textbox', { name: 'Zone name' })).toHaveValue(project.name);
    await popover.getByRole('combobox', { name: 'Bind to' }).selectOption(`folder:${repo}`);
    await window.screenshot({ path: test.info().outputPath('add-zone-linear-project.png'), animations: 'disabled' });
    await popover.getByRole('button', { name: /^Add zone/ }).click();
    await expect(popover).toBeHidden();

    const zone = zoneNamed(window, project.name);
    expect((await zones(window)).find((z) => z.name === project.name)).toMatchObject({
      repoRoot: repo,
      tracker: { provider: 'linear', scope, project: project.id },
    });

    // Its picker lists the project's issues, and only them.
    await zone.getByRole('button', { name: 'Add issue' }).click();
    const picker = window.getByRole('dialog', { name: 'Add an issue' });
    await expect(picker.getByRole('option').filter({ hasText: knownIssue.id })).toBeVisible();
    await expect(picker.getByRole('option')).toHaveCount(inProject.length);
    await expect(picker.getByRole('option').filter({ hasText: 'ACME-9999' })).toHaveCount(0);
    await picker.getByRole('option').filter({ hasText: knownIssue.id }).click();
    await picker.getByRole('button', { name: 'Start agent' }).click();
    await expect(picker).toBeHidden();
    const newAgent = window.getByRole('dialog', { name: 'New agent' });
    await expect(newAgent.getByTestId('selected-issue')).toContainText(knownIssue.id);
    await newAgent.getByRole('button', { name: 'Start' }).click();
    await expect(newAgent).toBeHidden();

    // The session starts, linked to the issue, with the project's card in the zone.
    await expect(window.getByTestId('agent-tile').filter({ hasText: knownIssue.id })).toBeVisible();
    const card = window.getByTestId('issue-card').filter({ hasText: knownIssue.title });
    await expect(card).toHaveAttribute('data-zone', (await zones(window)).find((z) => z.name === project.name)!.id);
    // (The "issue brief" edge itself is the team test's to check.)
    const [agent] = (await agents(window)).filter((a) => a.issue !== null);
    expect(agent!.issue).toMatchObject({ provider: 'linear', id: knownIssue.id });
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
    keychain.remove();
    await linear.close();
  }
});
