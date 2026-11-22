import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) out.push(full);
  }
  return out;
}

const files = await walk("src");
files.push(...(await walk("test")));
files.push(...(await walk("scripts")));
for (const file of files) execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
console.log(`syntax ok: ${files.length} files`);
