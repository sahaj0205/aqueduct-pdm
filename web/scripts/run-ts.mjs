/**
 * Run one of the verification scripts, TypeScript and all, without a test runner.
 *
 * Node on this machine is not built with TypeScript support, so
 * --experimental-strip-types is unavailable, and adding a runtime like tsx for three
 * scripts is not worth a dependency. esbuild is already present because Vite depends on
 * it, so this bundles in memory and executes the result.
 *
 * The plugin stubs CSS module imports. It is needed because esbuild treats *.module.css
 * as a CSS module and refuses to bundle one without an output path, and --loader does
 * not override that. The stub returns each requested key as its own class name, which
 * is what a CSS module does anyway; the plant drawing renders correctly through it
 * because every colour in that SVG is a fill or stroke attribute computed from data
 * rather than a style rule.
 *
 *     node scripts/run-ts.mjs scripts/verify-twin.ts
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import esbuild from "esbuild";

const entry = process.argv[2];
if (!entry) {
  console.error("usage: node scripts/run-ts.mjs <entry.ts>");
  process.exit(2);
}

const cssModuleStub = {
  name: "css-module-stub",
  setup(build) {
    build.onResolve({ filter: /\.css$/ }, (args) => ({
      path: args.path,
      namespace: "css-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "css-stub" }, () => ({
      contents:
        "export default new Proxy({}, { get: (_target, key) => String(key) });",
      loader: "js",
    }));
  },
};

const built = await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  write: false,
  logLevel: "warning",
  plugins: [cssModuleStub],
  // react-dom/server is CommonJS and calls require("stream"). Bundled into an ESM
  // output there is no `require` in scope, so one is created from import.meta.url. This
  // is the standard shim for pulling CommonJS dependencies into an ESM bundle and it is
  // needed the moment a verification script renders a React tree.
  banner: {
    js:
      'import { createRequire as __createRequire } from "node:module";\n' +
      "const require = __createRequire(import.meta.url);",
  },
});

// Written to a temp file rather than imported as a data: URL. A data URL works but any
// error inside it reports the entire base64 bundle as the specifier, which buries the
// actual stack trace under megabytes of noise. A real file gives real line numbers.
const dir = mkdtempSync(join(tmpdir(), "aqueduct-verify-"));
const file = join(dir, "bundle.mjs");
writeFileSync(file, built.outputFiles[0].text);
try {
  await import(pathToFileURL(file).href);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
