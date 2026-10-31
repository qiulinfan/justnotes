// `bun run start`: runs the built app from the repo, as justnotes.app on macOS
// (src/cli/dev-app.ts), passing on its arguments (`--vault <path>` ...).
import * as path from "node:path";
import { devElectron } from "../src/cli/dev-app";

const root = path.resolve(import.meta.dir, "..");
const child = Bun.spawn([devElectron(root), root, ...process.argv.slice(2)], { stdio: ["inherit", "inherit", "inherit"] });
process.exit(await child.exited);
