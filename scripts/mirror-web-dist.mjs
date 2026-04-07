import { cp, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const webDistDir = path.join(repoRoot, "apps", "web", "dist");
const rootDistDir = path.join(repoRoot, "dist");

async function main() {
  try {
    const distStats = await stat(webDistDir);
    if (!distStats.isDirectory()) {
      throw new Error(`${webDistDir} is not a directory`);
    }
  } catch (error) {
    throw new Error(`Expected web build output at ${webDistDir}: ${String(error)}`);
  }

  await rm(rootDistDir, { recursive: true, force: true });
  await cp(webDistDir, rootDistDir, { recursive: true });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
