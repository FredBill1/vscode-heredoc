import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../');
  const extensionTestsPath = path.resolve(__dirname, './suite/live.test');
  const installed = process.env.HEREDOC_EXTENSIONS_DIR ?? path.join(os.homedir(), '.vscode', 'extensions');
  const useInstalledExtensions = process.env.HEREDOC_LIVE_ALL_EXTENSIONS === '1';
  const selected = path.join(extensionDevelopmentPath, '.vscode-test', 'live-extensions');
  const userData = path.join(extensionDevelopmentPath, '.vscode-test', 'live-user-data');
  await fs.mkdir(selected, { recursive: true });
  await fs.mkdir(path.join(userData, 'User'), { recursive: true });
  await fs.writeFile(path.join(userData, 'User', 'settings.json'), JSON.stringify({
    'extensions.autoUpdate': false,
    'extensions.autoCheckUpdates': false,
    'telemetry.telemetryLevel': 'off',
  }));
  const wanted = [
    'ms-python.python-', 'ms-python.vscode-pylance-',
    'ms-python.vscode-python-envs-', 'ms-python.debugpy-',
    'redhat.vscode-yaml-', 'mads-hartmann.bash-ide-vscode-',
  ];
  if (!useInstalledExtensions) {
    const entries = await fs.readdir(installed, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !wanted.some(prefix => entry.name.startsWith(prefix))) continue;
      const link = path.join(selected, entry.name);
      try {
        await fs.symlink(path.join(installed, entry.name), link, process.platform === 'win32' ? 'junction' : 'dir');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
  }
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [
      `--extensions-dir=${useInstalledExtensions ? installed : selected}`, `--user-data-dir=${userData}`,
      '--disable-updates', '--skip-welcome', '--skip-release-notes',
    ],
    ...(process.env.VSCODE_EXECUTABLE_PATH
      ? { vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH }
      : {}),
  });
}

void main().catch(error => {
  console.error('Live VS Code integration smoke test failed:', error);
  process.exitCode = 1;
});
