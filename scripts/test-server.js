// Cross-platform helper to stage docker/server/www and run Go server tests.
//   node scripts/test-server.js
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const serverDir = path.join(root, "docker", "server");
const wwwDir = path.join(serverDir, "www");

console.log("Staging static assets for Go embedded server tests...");
fs.rmSync(wwwDir, { recursive: true, force: true });
fs.mkdirSync(wwwDir, { recursive: true });

function copyRec(src, dst) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(src)) {
      copyRec(path.join(src, f), path.join(dst, f));
    }
  } else {
    fs.copyFileSync(src, dst);
  }
}

// 1. Copy top-level and directories
for (const f of ["index.html", "all.html", "toolbox.html", "catalog.js", "manifest.json", "sw.js"]) {
  fs.copyFileSync(path.join(root, f), path.join(wwwDir, f));
}
copyRec(path.join(root, "assets"), path.join(wwwDir, "assets"));
copyRec(path.join(root, "sheets"), path.join(wwwDir, "sheets"));

// 2. Gzip every file to .gz (matching Dockerfile staging)
function gzipRec(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      gzipRec(full);
    } else if (ent.isFile()) {
      const data = fs.readFileSync(full);
      const gz = zlib.gzipSync(data, { level: 9 });
      fs.writeFileSync(full + ".gz", gz);
      fs.unlinkSync(full);
    }
  }
}
gzipRec(wwwDir);
console.log("Staged & gzipped assets. Running 'go test ./...' in docker/server...");

const res = spawnSync("go", ["test", "-v", "./..."], { cwd: serverDir, stdio: "inherit", shell: true });
if (res.status !== 0) {
  process.exit(res.status || 1);
}
console.log("Go server tests passed!");
