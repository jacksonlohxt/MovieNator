#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { DEFAULT_FIXTURE_DIR, DEFAULT_OUTPUT_DIR, evaluateFixtures, renderAggregateSummary } from "./harness.js";

function usage() {
  return `Usage: npm run eval -- [options]

Options:
  --fixture <id>       Run only one fixture. May be repeated.
  --fixtures <path>    Read fixtures from a different directory.
  --output <path>      Write JSON and Markdown reports to this directory.
  --no-write            Print the aggregate summary without writing report files.
  --help                Show this help.

The default run is fully offline and uses only eval/fixtures plus the local deterministic
Producer Intake builder. NotebookLM and incumbent comparison records are not_run scaffolds.
`;
}

function parseArgs(argv) {
  const options = { fixtureIds: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--fixture") options.fixtureIds.push(argv[++index]);
    else if (argument === "--fixtures") options.fixtureDir = path.resolve(argv[++index]);
    else if (argument === "--output") options.outputDir = path.resolve(argv[++index]);
    else if (argument === "--no-write") options.noWrite = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage());
    } else {
      const report = evaluateFixtures({
        fixtureDir: options.fixtureDir || DEFAULT_FIXTURE_DIR,
        fixtureIds: options.fixtureIds,
        outputDir: options.noWrite ? undefined : (options.outputDir || DEFAULT_OUTPUT_DIR),
      });
      process.stdout.write(renderAggregateSummary(report.aggregate, report.results));
      if (!options.noWrite) process.stdout.write(`\nReports written to ${options.outputDir || DEFAULT_OUTPUT_DIR}\n`);
    }
  } catch (error) {
    process.stderr.write(`Evaluation failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
