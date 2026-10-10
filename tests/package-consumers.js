import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { readPackRecord } from "./pack-result.js";

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is unavailable; run this check through npm");
const root = process.cwd();
const npm = (args, options) => execFileSync(process.execPath, [npmCli, ...args], options);
const contract = JSON.parse(await readFile("tests/public-contract.json", "utf8"));
const directory = await mkdtemp(join(tmpdir(), "askr-node-consumer-"));
try {
  const packed = readPackRecord(
    JSON.parse(
      npm(["pack", "--ignore-scripts", "--json", "--pack-destination", directory], {
        encoding: "utf8",
      }),
    ),
  );
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  npm(
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      join(directory, packed.filename),
      "@types/node@24.19.2",
    ],
    { cwd: directory, stdio: "pipe" },
  );
  const manifest = JSON.parse(
    await readFile(join(directory, "node_modules/@askrjs/node/package.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(manifest.exports).sort(), contract.exportKeys);
  const fixture = join(directory, "contract.ts");
  const surfaces = Object.keys(contract.entrypoints);
  await writeFile(
    fixture,
    `${await readFile("tests/types/public-contract.ts", "utf8")}\n${surfaces.map((name, index) => `import * as Surface${index} from ${JSON.stringify(name)}; void Surface${index};`).join("\n")}\n`,
  );
  await writeFile(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        types: ["node"],
        lib: ["ES2022", "DOM", "DOM.Iterable"],
      },
      files: ["contract.ts"],
    }),
  );
  execFileSync(
    process.execPath,
    [join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"],
    { cwd: directory, stdio: "pipe" },
  );
  const program = ts.createProgram([fixture], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    types: ["node"],
    typeRoots: [join(directory, "node_modules/@types")],
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(
    diagnostics.length,
    0,
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (file) => file,
      getCurrentDirectory: () => directory,
      getNewLine: () => "\n",
    }),
  );
  const checker = program.getTypeChecker();
  for (const [name, surface] of Object.entries(contract.entrypoints)) {
    const declaration = program
      .getSourceFile(fixture)
      .statements.find(
        (statement) => ts.isImportDeclaration(statement) && statement.moduleSpecifier.text === name,
      );
    const names = checker
      .getExportsOfModule(checker.getSymbolAtLocation(declaration.moduleSpecifier))
      .map((symbol) => symbol.name)
      .sort();
    assert.deepEqual(names, [...surface.values, ...surface.types].sort(), name);
  }
  await writeFile(
    join(directory, "runtime.js"),
    `${await readFile("tests/packed-runtime.js", "utf8")}\nfor (const path of ${JSON.stringify(contract.privateSubpaths)}) await assert.rejects(import('@askrjs/node/' + path), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });\n`,
  );
  execFileSync(process.execPath, [join(directory, "runtime.js")], {
    cwd: directory,
    stdio: "pipe",
    timeout: 20_000,
  });
  await writeFile(
    join(directory, "diagnostics.js"),
    await readFile("tests/packed-diagnostics.js", "utf8"),
  );
  execFileSync(process.execPath, [join(directory, "diagnostics.js")], {
    cwd: directory,
    stdio: "pipe",
    timeout: 20_000,
  });
  await writeFile(
    join(directory, "output-failure.js"),
    await readFile("tests/packed-output-failure.js", "utf8"),
  );
  execFileSync(process.execPath, [join(directory, "output-failure.js")], {
    cwd: directory,
    stdio: "pipe",
    timeout: 20_000,
  });
  console.log(
    JSON.stringify({
      normalInstall: true,
      declarationNames: 13,
      removedNames: contract.removed.length,
      privateSubpaths: contract.privateSubpaths.length,
      compilers: ["6.0.2", "7.0.2"],
      runtime: [
        "real HTTP",
        "HTML cache policy",
        "real MCP",
        "cleanup",
        "asynchronous diagnostics failure after close",
        "asynchronous protocol output failure after close",
      ],
    }),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
