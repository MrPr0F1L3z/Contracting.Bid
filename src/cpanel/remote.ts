/**
 * The SSH and rsync side of a deploy to the cPanel host. These functions only build argv lists
 * and short sh scripts; src/cli/cpanel.ts runs them. Nothing here edits the server by hand:
 * every change on the host is one of these commands, run by the pipeline.
 */
import type { Target } from "./site.js";
import { checkRemotePath } from "./uapi.js";

export interface SshTarget {
  host: string;
  user: string;
  port: number;
  /** Path to the private key on the machine that runs the deploy. */
  keyFile: string;
  /** known_hosts file holding the host's key. Required: the host's key is always checked. */
  knownHostsFile: string;
}

/** Quotes a word for sh. */
export function shellQuote(word: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** Checks a port number from a setting. */
export function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 22;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`CPANEL_PORT must be a port number, not "${raw}"`);
  return n;
}

/** The ssh options used for every connection: key only, no prompts, host key must match. */
export function sshOptions(t: SshTarget): string[] {
  return [
    "-i", t.keyFile,
    "-p", String(t.port),
    "-o", "BatchMode=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${t.knownHostsFile}`,
    "-o", "ConnectTimeout=20",
  ];
}

/** argv for `ssh` running one command line on the host. */
export function sshArgv(t: SshTarget, remoteCommand: string): string[] {
  return [...sshOptions(t), `${t.user}@${t.host}`, remoteCommand];
}

/** Where the pipeline keeps its own files on the host (backups), outside every web folder. */
export const STATE_DIR = "$HOME/.contracting-bid-deploy";

/** Folders in a document root the deploy never deletes or overwrites. */
export const PROTECTED = [".well-known/", "cgi-bin/", ".user.ini", "php.ini", "error_log"];

/** How many backups of each target are kept on the host. */
export const KEEP_BACKUPS = 5;

/** A backup file name for a target at a time, e.g. production-20261121T230000Z.tar.gz. */
export function backupName(target: Target, at: Date): string {
  return `${target}-${at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}.tar.gz`;
}

/**
 * sh that saves the document root's current files to a backup and keeps the newest
 * KEEP_BACKUPS for that target. Prints the backup's path. An empty root gives an empty backup.
 */
export function backupScript(target: Target, root: string, at: Date, nested: readonly string[] = []): string {
  const r = checkRemotePath(root, "backup");
  const file = `${STATE_DIR}/backups/${backupName(target, at)}`;
  const excludes = nested.map((n) => `--exclude=${shellQuote(`./${n.replace(/\/$/, "")}`)}`).join(" ");
  return [
    "set -eu",
    `mkdir -p "${STATE_DIR}/backups"`,
    `chmod 700 "${STATE_DIR}"`,
    `mkdir -p ${shellQuote(r)}`,
    `tar -czf "${file}" ${excludes ? `${excludes} ` : ""}-C ${shellQuote(r)} .`,
    `ls -1t "${STATE_DIR}/backups"/${target}-*.tar.gz | tail -n +${KEEP_BACKUPS + 1} | while read -r old; do rm -f -- "$old"; done`,
    `echo "${file}"`,
  ].join("\n");
}

/** sh that lists a target's backups on the host, newest first. */
export function listBackupsScript(target: Target): string {
  return `ls -1t "${STATE_DIR}/backups"/${target}-*.tar.gz 2>/dev/null || true`;
}

/** Checks a backup path that came back from the host before it goes into a restore. */
export function checkBackupPath(path: string, target: Target): string {
  const p = path.trim();
  const m = /^(\/[A-Za-z0-9._\-/]+)\/\.contracting-bid-deploy\/backups\/([a-z]+)-\d{8}T\d{6}Z\.tar\.gz$/.exec(p);
  if (!m || m[2] !== target || p.includes("..")) throw new Error(`Not a ${target} backup: "${path}"`);
  return p;
}

/** rsync filter arguments that keep protected and nested folders out of a sync, both ways. */
function excludeArgs(nested: readonly string[]): string[] {
  return [...PROTECTED, ...nested].map((p) => `--exclude=/${p}`);
}

/**
 * sh that puts a backup back: unpacks it beside the root, syncs it over the root (removing
 * files the backup does not have, but never protected or nested folders), then removes the copy.
 */
export function restoreScript(root: string, backup: string, target: Target, nested: readonly string[] = []): string {
  const r = checkRemotePath(root, "restore");
  const b = checkBackupPath(backup, target);
  const tmp = `${STATE_DIR}/restore-${target}`;
  return [
    "set -eu",
    `rm -rf "${tmp}"`,
    `mkdir -p "${tmp}"`,
    `tar -xzf ${shellQuote(b)} -C "${tmp}"`,
    `rsync -rlt --checksum --delete ${excludeArgs(nested).map(shellQuote).join(" ")} "${tmp}/" ${shellQuote(`${r}/`)}`,
    `rm -rf "${tmp}"`,
    `echo restored ${shellQuote(b)}`,
  ].join("\n");
}

export interface RsyncPlan {
  localDir: string;
  root: string;
  nested: readonly string[];
  dryRun: boolean;
}

/**
 * argv for rsync from the built site to the document root. Files the build does not have are
 * removed (after the new ones are in place), except protected and nested folders. A dry run lists
 * every change and makes none.
 */
export function rsyncArgv(t: SshTarget, plan: RsyncPlan): string[] {
  const r = checkRemotePath(plan.root, "deploy");
  const local = plan.localDir.endsWith("/") ? plan.localDir : `${plan.localDir}/`;
  return [
    "--recursive",
    "--links",
    "--times",
    "--checksum",
    "--delete-after",
    "--delay-updates",
    "--chmod=D755,F644",
    "--itemize-changes",
    ...(plan.dryRun ? ["--dry-run"] : []),
    ...excludeArgs(plan.nested),
    "-e",
    ["ssh", ...sshOptions(t)].map(shellQuote).join(" "),
    local,
    `${t.user}@${t.host}:${r}/`,
  ];
}

/** Counts the changes in rsync --itemize-changes output: files sent, and files deleted. */
export function summarizeRsync(output: string): { sent: number; deleted: number; deletedPaths: string[] } {
  const lines = output.split("\n").map((l) => l.trimEnd()).filter(Boolean);
  const deletedPaths = lines.filter((l) => l.startsWith("*deleting")).map((l) => l.replace(/^\*deleting\s+/, ""));
  const sent = lines.filter((l) => /^[<>]f/.test(l)).length;
  return { sent, deleted: deletedPaths.length, deletedPaths };
}

/** sh that checks the host has the tools a deploy needs. Prints one line per missing tool. */
export const TOOLS_CHECK = 'for t in uapi rsync tar; do command -v "$t" >/dev/null 2>&1 || echo "missing $t"; done; true';
