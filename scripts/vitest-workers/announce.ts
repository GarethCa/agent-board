import type { TestProject } from 'vitest/node';

/** Vitest globalSetup: say once, at the start of a run, how many workers each project got and why. */
export default function announceWorkers(project: TestProject): void {
  const projects = project.vitest.projects;
  const cap = (name: string): number | undefined => projects.find((p) => p.name === name)?.config.maxWorkers;
  const why = projects[0]?.config.env?.AGENT_BOARD_VITEST_WHY;
  console.log(`vitest workers: unit ${cap('unit')}, processes ${cap('processes')} (${why})`);
}
