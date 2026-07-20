import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is unavailable; run this check through npm");
const result = JSON.parse(
  execFileSync(process.execPath, [npmCli, "pack", "--ignore-scripts", "--dry-run", "--json"], {
    encoding: "utf8",
  }),
);

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const dependencies = Object.keys(manifest.dependencies ?? {}).sort();
const allowedDependencies = ["@askrjs/auth", "@askrjs/server"];
if (JSON.stringify(dependencies) !== JSON.stringify(allowedDependencies)) {
  throw new Error(`Unexpected production dependencies: ${dependencies.join(", ")}`);
}

if (result.length !== 1) {
  throw new Error(`Expected one packed artifact, received ${result.length}.`);
}

const packedFiles = new Set(result[0].files.map(({ path }) => normalize(path)));
for (const required of [
  "LICENSE",
  "README.md",
  "package.json",
  "dist/index.js",
  "dist/index.d.ts",
]) {
  if (!packedFiles.has(normalize(required)))
    throw new Error(`Packed artifact is missing ${required}.`);
}
for (const file of packedFiles) {
  if (
    file !== normalize("LICENSE") &&
    file !== normalize("README.md") &&
    file !== normalize("package.json") &&
    !file.startsWith(`${normalize("dist")}\\`) &&
    !file.startsWith(`${normalize("dist")}/`)
  ) {
    throw new Error(`Unexpected packed file ${file}.`);
  }
}
const sourceMappingPattern = /[#@]\s*sourceMappingURL=([^\s*]+)/gu;

for (const file of result[0].files) {
  if (!/\.(?:css|d\.ts|js)$/u.test(file.path)) continue;

  const source = readFileSync(file.path, "utf8");
  for (const match of source.matchAll(sourceMappingPattern)) {
    const reference = match[1];
    if (reference.startsWith("data:")) continue;
    if (/^[a-z][a-z\d+.-]*:/iu.test(reference)) {
      throw new Error(`${file.path} references external source map ${reference}.`);
    }

    const mapPath = normalize(join(dirname(file.path), decodeURIComponent(reference)));
    if (!packedFiles.has(mapPath)) {
      throw new Error(`${file.path} references missing packed source map ${mapPath}.`);
    }
  }
}
