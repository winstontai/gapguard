// tsc only emits .ts -> .js, so runtime assets have to be copied into dist for `npm start`.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const assets = [
  ["src/portfolio/schema.sql", "dist/portfolio/schema.sql"],
  ["src/web/index.html", "dist/web/index.html"],
];

for (const [from, to] of assets) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}
console.log(`copied ${assets.length} runtime assets into dist`);
