// Friendly Node version check. OFSD uses Node's built-in SQLite (no native builds needed).
const [maj, min] = process.versions.node.split('.').map(Number);
const ok = maj > 22 || (maj === 22 && min >= 13);
if (!ok) {
  console.error(`\n  OFSD Terminal needs Node.js 22.13 or newer. You have ${process.versions.node}.`);
  console.error('  Download the LTS installer from https://nodejs.org, run it, then try again.\n');
  process.exit(1);
}
