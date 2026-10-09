import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { config } from "../config.js";
import { parseEngramExport } from "./engram.js";
import { loadEngramSourcesConfig } from "./engram-config.js";

/** `npm run engram:export`: one `engram export` per allowlisted project into the gitignored export dir. */

export interface ExportCommand {
  project: string;
  outFile: string;
  command: "engram";
  args: string[];
}

export type CommandRunner = (command: string, args: string[]) => Promise<void>;

export function buildExportCommands(projects: readonly string[], outDir: string): ExportCommand[] {
  return projects.map((project) => {
    const outFile = join(outDir, `${project}.json`);
    return { project, outFile, command: "engram", args: ["export", outFile, "--project", project] };
  });
}

/** argv only, never a shell string: project names cannot be interpreted by a shell. */
const execFileAsync = promisify(execFile);
export const runWithExecFile: CommandRunner = async (command, args) => {
  await execFileAsync(command, args, { timeout: 120_000, maxBuffer: 1024 * 1024 });
};

export async function exportProjects(projects: readonly string[], outDir: string, run: CommandRunner = runWithExecFile) {
  await mkdir(outDir, { recursive: true });
  const results = [];
  for (const { project, outFile, command, args } of buildExportCommands(projects, outDir)) {
    try {
      await run(command, args);
    } catch (error) {
      throw new Error(`engram export failed for project "${project}": ${error instanceof Error ? error.message : String(error)}`);
    }
    const data = parseEngramExport(JSON.parse(await readFile(outFile, "utf8")), outFile);
    results.push({ project, outFile, observations: data.observations.length });
  }
  return results;
}

async function main(): Promise<void> {
  const sources = await loadEngramSourcesConfig(config.engram.configPath);
  const results = await exportProjects(sources.projects, config.engram.exportDir);
  for (const r of results) console.log(`${r.project}: ${r.observations} observations → ${r.outFile}`);
  console.log(`Exported ${results.length} projects. Run \`npm run ingest\` to index them (filters apply at ingest).`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
