/**
 * Reads a Playwright JSON report (the `json` reporter) for the tests that failed and then passed on a retry: they pass
 * the gate, and the gate names them so they get fixed.
 */

interface ReportTest {
  projectName?: string;
  status?: string;
}
interface ReportSpec {
  title: string;
  file: string;
  line: number;
  tests?: ReportTest[];
}
interface ReportSuite {
  title: string;
  specs?: ReportSpec[];
  suites?: ReportSuite[];
}

/** Each flaky test as `[project] file:line › describe › title`, the project left out when the run had none. */
export function flakyTests(report: unknown): string[] {
  const suites = (report as { suites?: ReportSuite[] } | undefined)?.suites ?? [];
  const names: string[] = [];
  // A file's own suite is titled with its path, which the spec's `file` already gives; nested ones are describes.
  const visit = (suite: ReportSuite, describes: string[]): void => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        if (test.status !== 'flaky') continue;
        const project = test.projectName ? `[${test.projectName}] ` : '';
        names.push(`${project}${[`${spec.file}:${spec.line}`, ...describes, spec.title].join(' › ')}`);
      }
    }
    for (const child of suite.suites ?? []) visit(child, [...describes, child.title]);
  };
  for (const suite of suites) visit(suite, []);
  return names;
}
