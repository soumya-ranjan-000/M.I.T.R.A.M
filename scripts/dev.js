// Builds the extension and opens an Extension Development window WITHOUT attaching the debugger.
// Extra arguments are passed on to `code`, e.g. `npm run dev -- --user-data-dir=/tmp/profile`.
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const shell = process.platform === 'win32'; // npm and code are .cmd files on Windows

const build = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell });
if (build.status !== 0) process.exit(build.status ?? 1);

// Absolute paths: a relative one is resolved by VS Code's own launcher, not from this folder.
const args = [`--extensionDevelopmentPath=${root}`, '--disable-extensions', path.join(root, 'sandbox'), ...process.argv.slice(2)];
const child = spawn('code', args, { stdio: 'inherit', shell });
child.on('error', (e) => {
  console.error(`Could not start "code": ${e.message}\nInstall the shell command from the Command Palette: "Shell Command: Install 'code' command in PATH".`);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 0));
