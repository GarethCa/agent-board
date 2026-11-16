import type { TestProject } from 'vitest/node';

/** Vitest globalSetup: say once, at the start of a run, how many workers each project got and why. */
export default function announceWorkers(project: TestProject): void {
  const projects = project.vitest.projects;
  const why = projects[0]?.config.env?.AGENT_BOARD_VITEST_WHY;
  // Only the projects this run has: `--project server` runs that one alone.
  console.log(`vitest workers: ${projects.map((p) => `${p.name} ${p.config.maxWorkers}`).join(', ')} (${why})`);
}
