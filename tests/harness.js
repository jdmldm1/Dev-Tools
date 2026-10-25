// Loads the toolbox shell and tool modules in plain Node (no DOM) so their pure functions on DT.lib can be tested.
const fs = require("fs"), path = require("path"), vm = require("vm");

globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.document = undefined;

const root = path.join(__dirname, "..");
function load(rel) {
  vm.runInThisContext(fs.readFileSync(path.join(root, rel), "utf8"), { filename: rel });
}
load("assets/toolbox.js");
load("assets/tools/base64.js");
load("assets/shell.js");
for (const f of fs.readdirSync(path.join(root, "assets/tools")).sort()) load("assets/tools/" + f);

module.exports = { DT: globalThis.DT, lib: globalThis.DT.lib };
