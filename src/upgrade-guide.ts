import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appVersion, OriaError } from './domain.js';
import { compareSemVer, officialReleaseUrl, parseSemVer } from './semver.js';
import {
  getUpdateStatus, isPathInside, OFFICIAL_REPO_URL, resolveUpdateDir, safeRealpath,
  type AvailabilityStatus, type UpdateOptions,
} from './update.js';

const OFFICIAL_GIT_URLS = new Set([
  'https://github.com/Rosezzv/oria',
  'https://github.com/Rosezzv/oria.git',
  'git@github.com:Rosezzv/oria',
  'git@github.com:Rosezzv/oria.git',
  'ssh://git@github.com/Rosezzv/oria',
  'ssh://git@github.com/Rosezzv/oria.git',
]);

export type InstallKind = 'official_release_clone' | 'dev_workspace' | 'custom_install';

export interface InstallInspection {
  install_dir: string;
  install_kind: InstallKind;
  matches_official_repo: boolean;
  suitable_for_official_guide: boolean;
  worktree_status: 'not_inspected';
  branch?: string;
  release_tag?: string;
  reason?: string;
}

export interface UpgradeGuide {
  read_only: true;
  availability_status: AvailabilityStatus;
  current_version: string;
  target_version: string | null;
  target_tag: string | null;
  release_url: string;
  install: InstallInspection;
  vault_path: string;
  vault_overlaps_install: boolean;
  warnings: string[];
  steps: string[];
  verification_steps: string[];
  skill_notes: string[];
  preserves: string[];
}

export interface UpgradeGuideOptions extends UpdateOptions {
  vaultPath?: string;
  installDir?: string;
  targetVersion?: string;
}

const PRESERVED_ASSETS = [
  'User Markdown notes and attachments (library/)',
  'Document history snapshots (library/.oria-history/)',
  'Existing ZIP backups',
  'Custom vault path and Agent MCP configurations',
];

export function defaultInstallDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

function resolveCurrentVersion(explicit?: string): string {
  return explicit ?? process.env.ORIA_APP_VERSION_OVERRIDE ?? appVersion;
}

function resolveVaultPath(explicit?: string): string {
  return safeRealpath(explicit ?? (process.env.ORIA_VAULT || join(homedir(), '.oria', 'vault')));
}

export function pathsOverlap(left: string, right: string): boolean {
  return isPathInside(left, right) || isPathInside(right, left);
}

// Metadata-only Git inspection: never runs worktree status/diff scans so repo content filters,
// hooks, fsmonitor, and index refreshes cannot be triggered.
function runReadOnlyGitMetadata(cwd: string, args: string[], timeout = 5000) {
  return spawnSync('git', [
    '--no-optional-locks',
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false',
    '-c', 'gc.auto=0',
    ...args,
  ], {
    cwd,
    encoding: 'utf8',
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
}

export function inspectInstallationReadOnly(installDir: string): InstallInspection {
  const resolvedDir = safeRealpath(installDir);
  const gitEntry = join(resolvedDir, '.git');
  const gitStat = lstatSync(gitEntry, { throwIfNoEntry: false });

  if (!gitStat) {
    return {
      install_dir: resolvedDir,
      install_kind: 'custom_install',
      matches_official_repo: false,
      suitable_for_official_guide: true,
      worktree_status: 'not_inspected',
      reason: 'Installation directory is not a Git clone; follow conservative side-by-side manual installation steps.',
    };
  }

  if (gitStat.isSymbolicLink() || !gitStat.isDirectory()) {
    return {
      install_dir: resolvedDir,
      install_kind: 'dev_workspace',
      matches_official_repo: false,
      suitable_for_official_guide: false,
      worktree_status: 'not_inspected',
      reason: 'Installation directory is a Git worktree or symlinked checkout.',
    };
  }

  const originRun = runReadOnlyGitMetadata(resolvedDir, ['remote', 'get-url', 'origin']);
  const originUrl = originRun.status === 0 ? originRun.stdout.trim() : undefined;
  const matchesOfficial = Boolean(originUrl && OFFICIAL_GIT_URLS.has(originUrl));
  // Never expose raw non-official remote URLs (which may contain private hosts, usernames, or credentials).
  if (!matchesOfficial) {
    return {
      install_dir: resolvedDir,
      install_kind: 'dev_workspace',
      matches_official_repo: false,
      suitable_for_official_guide: false,
      worktree_status: 'not_inspected',
      reason: 'Origin remote does not match the official public ORIA repository (Rosezzv/oria).',
    };
  }

  const branchRun = runReadOnlyGitMetadata(resolvedDir, ['branch', '--show-current']);
  if (branchRun.status !== 0) {
    return {
      install_dir: resolvedDir,
      install_kind: 'dev_workspace',
      matches_official_repo: true,
      suitable_for_official_guide: false,
      worktree_status: 'not_inspected',
      reason: 'Could not read Git branch metadata; treating conservatively as a custom/developer checkout.',
    };
  }
  const branch = branchRun.stdout.trim() || undefined;

  if (branch) {
    if (branch !== 'main') {
      return {
        install_dir: resolvedDir,
        install_kind: 'dev_workspace',
        matches_official_repo: true,
        suitable_for_official_guide: false,
        worktree_status: 'not_inspected',
        branch,
        reason: `Checked out on branch "${branch}" rather than a release tag or tracked main.`,
      };
    }
    const upstreamRun = runReadOnlyGitMetadata(resolvedDir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    if (upstreamRun.status !== 0) {
      return {
        install_dir: resolvedDir,
        install_kind: 'dev_workspace',
        matches_official_repo: true,
        suitable_for_official_guide: false,
        worktree_status: 'not_inspected',
        branch,
        reason: 'Local main branch has no configured upstream tracking branch.',
      };
    }
    const aheadRun = runReadOnlyGitMetadata(resolvedDir, ['rev-list', '--count', '@{u}..HEAD']);
    if (aheadRun.status !== 0 || Number(aheadRun.stdout.trim()) > 0) {
      return {
        install_dir: resolvedDir,
        install_kind: 'dev_workspace',
        matches_official_repo: true,
        suitable_for_official_guide: false,
        worktree_status: 'not_inspected',
        branch,
        reason: 'Local main branch has unpushed commits ahead of upstream.',
      };
    }
    return {
      install_dir: resolvedDir,
      install_kind: 'official_release_clone',
      matches_official_repo: true,
      suitable_for_official_guide: true,
      worktree_status: 'not_inspected',
      branch,
      reason: 'Worktree modifications are intentionally not scanned to avoid running local Git content filters.',
    };
  }

  const tagsRun = runReadOnlyGitMetadata(resolvedDir, ['tag', '--points-at', 'HEAD']);
  const releaseTag = tagsRun.status === 0
    ? tagsRun.stdout.split(/\r?\n/).map(t => t.trim()).find(t => Boolean(parseSemVer(t, { allowVPrefix: true })))
    : undefined;
  if (!releaseTag) {
    return {
      install_dir: resolvedDir,
      install_kind: 'dev_workspace',
      matches_official_repo: true,
      suitable_for_official_guide: false,
      worktree_status: 'not_inspected',
      reason: 'Detached HEAD does not point to a recognized SemVer release tag.',
    };
  }

  return {
    install_dir: resolvedDir,
    install_kind: 'official_release_clone',
    matches_official_repo: true,
    suitable_for_official_guide: true,
    worktree_status: 'not_inspected',
    release_tag: releaseTag,
    reason: 'Worktree modifications are intentionally not scanned to avoid running local Git content filters.',
  };
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function buildSideBySideSteps(
  tag: string,
  install: InstallInspection,
  vaultPath: string,
  vaultOverlapsInstall: boolean,
): string[] {
  const cliPath = join(install.install_dir, 'dist', 'cli.js');
  const suggestedDir = join(dirname(install.install_dir), `oria-${tag}`);
  const recommendedVault = join(homedir(), '.oria', 'vault');
  const targetVault = vaultOverlapsInstall ? recommendedVault : vaultPath;

  const steps: string[] = [
    `1. Confirm your current install directory (${install.install_dir}) and vault path (${vaultPath}).`,
    '2. Stop or close ALL AI Agents, ORIA MCP servers, CLI sessions, and external editors that may write to this vault BEFORE creating the final backup.',
    `3. After confirming writes have stopped, create your final ZIP backup (macOS/Linux Bash/Zsh): node ${shellQuote(cliPath)} --vault ${shellQuote(vaultPath)} export`,
  ];

  if (vaultOverlapsInstall) {
    steps.push(
      `4. IMPORTANT (nested vault): Your vault (${vaultPath}) overlaps the ORIA install directory. Restore the final ZIP into an empty, independent target vault directory outside the install folder (for example ${recommendedVault}): node ${shellQuote(cliPath)} --vault ${shellQuote(recommendedVault)} import <BACKUP.zip>`,
      `5. Verify your notes, latest revisions, history snapshots, and attachments inside ${recommendedVault} before switching any Agent configs.`,
    );
  }

  if (install.install_kind === 'dev_workspace') {
    steps.push(
      `Note: ${install.install_dir} looks like a developer workspace (${install.reason ?? 'local checkout'}). Leave it untouched and install the official release side-by-side in a separate directory.`,
    );
  }

  const nextNum = vaultOverlapsInstall ? 6 : 4;
  steps.push(
    `${nextNum}. Install the official release side-by-side (keeping ${install.install_dir} untouched as your manual fallback; macOS/Linux Bash/Zsh): git clone --branch ${shellQuote(tag)} --single-branch ${OFFICIAL_REPO_URL}.git ${shellQuote(suggestedDir)}`,
    `${nextNum + 1}. Install dependencies and build in the new directory: cd ${shellQuote(suggestedDir)} && npm ci && npm run build`,
    `${nextNum + 2}. Verify the new binary version: node ${shellQuote(join(suggestedDir, 'dist', 'cli.js'))} --json --version`,
    vaultOverlapsInstall
      ? `${nextNum + 3}. Update your Agent MCP configurations (Claude Code, Codex, Antigravity) and Grok Bot CLI path to point to ${join(suggestedDir, 'dist', 'cli.js')} and your verified independent vault path (--vault ${targetVault}), NOT the old nested path.`
      : `${nextNum + 3}. Update your Agent MCP configurations (Claude Code, Codex, Antigravity) and Grok Bot CLI path to point to ${join(suggestedDir, 'dist', 'cli.js')}, keeping your independent --vault ${targetVault} path unchanged. (Run ./scripts/install.sh in the new directory on macOS/Linux to print updated copy-paste configs.)`,
    `${nextNum + 4}. Refresh and reload Agent Skills, restart all connected Agents / MCP servers, verify the live running version and an existing note, and keep your previous install directory, old vault, and ZIP backup until fully verified.`,
  );

  return steps;
}

function buildSkillNotes(installDir: string, targetTag: string | null): string[] {
  const suggestedDir = targetTag ? join(dirname(installDir), `oria-${targetTag}`) : installDir;
  const notes = [
    `MCP hosts (Claude Code ~/.claude/skills/oria/SKILL.md, Codex ~/.agents/skills/oria/SKILL.md, Antigravity ~/.gemini/config/skills/oria/SKILL.md): compare and update your local Skill from ${join(suggestedDir, 'skills', 'oria', 'SKILL.md')}, then reload or restart the host so updated instructions take effect.`,
    `Grok Bot: re-import ${join(suggestedDir, 'skills', 'oria-grok-bot', 'SKILL.md')} as a private Skill and update its local CLI path to the new installation.`,
  ];
  const existingLocal = [
    join(homedir(), '.claude', 'skills', 'oria', 'SKILL.md'),
    join(homedir(), '.agents', 'skills', 'oria', 'SKILL.md'),
    join(homedir(), '.gemini', 'config', 'skills', 'oria', 'SKILL.md'),
  ].filter(path => existsSync(path));
  if (existingLocal.length) {
    notes.push(`Detected local Skill files: ${existingLocal.join(', ')}`);
  }
  return notes;
}

export function buildUpgradeGuide(options: UpgradeGuideOptions = {}): UpgradeGuide {
  const installDir = safeRealpath(options.installDir ?? defaultInstallDir());
  const vaultPath = resolveVaultPath(options.vaultPath);
  const stateDir = resolveUpdateDir(options.stateDir);
  const currentVersion = resolveCurrentVersion(options.currentVersion);

  const install = inspectInstallationReadOnly(installDir);
  const vaultOverlapsInstall = pathsOverlap(install.install_dir, vaultPath);
  const status = getUpdateStatus({ stateDir, currentVersion, vaultPath });

  let targetVersion: string | null = null;
  let targetTag: string | null = null;
  let releaseUrl = OFFICIAL_REPO_URL + '/releases';

  if (options.targetVersion !== undefined) {
    const parsedTarget = parseSemVer(options.targetVersion, { allowVPrefix: true });
    const parsedCurrent = parseSemVer(currentVersion, { allowVPrefix: true });
    if (!parsedTarget || parsedTarget.build.length > 0) {
      throw new OriaError('INVALID_INPUT', 'Target version must be a valid SemVer tag (e.g. v0.1.0-alpha.3)');
    }
    if (!parsedCurrent || compareSemVer(parsedTarget, parsedCurrent) <= 0) {
      throw new OriaError(
        'INVALID_INPUT',
        `Target version ${parsedTarget.canonical} is not newer than current version ${currentVersion}. Downgrades are not recommended automatically.`,
      );
    }
    targetVersion = parsedTarget.canonical;
    targetTag = options.targetVersion.startsWith('v') ? options.targetVersion : 'v' + parsedTarget.canonical;
    releaseUrl = officialReleaseUrl(targetTag);
  } else if (status.available_update) {
    targetVersion = status.available_update.version;
    targetTag = status.available_update.tag;
    releaseUrl = status.available_update.release_url;
  }

  const warnings: string[] = [];
  if (vaultOverlapsInstall) {
    warnings.push('Vault path overlaps the ORIA installation directory. First stop all writers (Agents/MCP/editors), then export the final ZIP and restore it into an empty independent vault directory before switching Agents.');
  }
  if (install.install_kind === 'dev_workspace') {
    warnings.push(`Developer workspace detected: ${install.reason ?? 'local checkout'}. Keep local work intact and upgrade manually.`);
  } else if (install.install_kind === 'custom_install') {
    warnings.push(install.reason ?? 'Custom non-Git installation detected; follow conservative side-by-side upgrade steps.');
  }
  if (status.availability_status === 'not_checked' && !targetTag) {
    warnings.push('No update check has succeeded yet. Run `oria updates check` (or ask your agent to check for updates) to inspect official GitHub Releases.');
  } else if (status.availability_status === 'check_failed' && !targetTag) {
    warnings.push(`Last update check did not succeed (${status.last_check_status ?? 'error'}). Verify network access or visit ${OFFICIAL_REPO_URL}/releases.`);
  } else if (status.availability_status === 'no_eligible_release' && !targetTag) {
    warnings.push(`No eligible releases were found on the "${status.channel}" channel yet (e.g. only pre-releases are published).`);
  }
  if (process.platform === 'win32') {
    warnings.push('Windows real-device upgrade verification has not been completed yet; translate the Bash/Zsh commands below to PowerShell quoting and keep your previous directory until verified.');
  }

  const steps = targetTag
    ? buildSideBySideSteps(targetTag, install, vaultPath, vaultOverlapsInstall)
    : [
      `Current ORIA version is ${currentVersion}. No newer target version is currently selected.`,
      `You can inspect official releases anytime at ${OFFICIAL_REPO_URL}/releases or run \`oria updates check\`.`,
    ];

  const verificationSteps = [
    'After restarting your Agent / MCP server, ask "What version of ORIA am I running?" (or run `oria --version`) to verify the live running version.',
    'Read an existing note in your vault to confirm Markdown notes, latest revisions, search, and history are intact.',
    'Keep your previous installation directory, old vault (if migrated), and ZIP backup until everything is verified; ORIA never deletes old assets automatically.',
  ];

  return {
    read_only: true,
    availability_status: targetTag ? 'update_available' : status.availability_status,
    current_version: currentVersion,
    target_version: targetVersion,
    target_tag: targetTag,
    release_url: releaseUrl,
    install,
    vault_path: vaultPath,
    vault_overlaps_install: vaultOverlapsInstall,
    warnings,
    steps,
    verification_steps: verificationSteps,
    skill_notes: buildSkillNotes(install.install_dir, targetTag),
    preserves: PRESERVED_ASSETS,
  };
}
