import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { COLLECTION_EXTENSION_ORIGIN } from '../../shared/collection-identity.ts';
import { writeFileAtomically } from '../files.ts';
import { CollectionError } from './validation.ts';

const run = promisify(execFile), canonical = (path: string) => resolve(path).toLowerCase();
const failure = () => new CollectionError('APP_UNAVAILABLE');
export async function safeConnectionDirectory(dataRoot: string, create = false): Promise<string> {
  const root = resolve(dataRoot), directory = join(root, 'collection-connection');
  if (canonical(await realpath(root)) !== canonical(root)) throw failure();
  if (create) await mkdir(directory).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || canonical(await realpath(directory)) !== canonical(directory)) throw failure();
  return directory;
}
async function safeFile(directory: string, name: string): Promise<string> {
  const path = join(directory, name);
  try { const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || canonical(await realpath(path)) !== canonical(path)) throw failure(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return path;
}
export async function writeConnectionFile(dataRoot: string, name: string, contents: string | Uint8Array): Promise<void> {
  const directory = await safeConnectionDirectory(dataRoot); await writeFileAtomically(await safeFile(directory, name), contents);
}
export async function hasPreparedConnection(dataRoot: string): Promise<boolean> {
  try { const directory = await safeConnectionDirectory(dataRoot); await lstat(join(directory, 'owner.json')); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

function registryScript(hostName: string, uninstall: boolean): string {
  // All script paths derive from its own directory. No user-supplied path or command is interpolated.
  return `$ErrorActionPreference = 'Stop'\n$hostName = '${hostName}'\n$manifest = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'native-host.json'))\n` + String.raw`
$locations = @('Software\Google\Chrome\NativeMessagingHosts\', 'Software\Microsoft\Edge\NativeMessagingHosts\')
$views = @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)
` + (uninstall ? String.raw`
foreach ($view in $views) {
  $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
  try { foreach ($location in $locations) {
    $path = $location + $hostName
    $key = $base.OpenSubKey($path)
    if ($null -ne $key) {
      try { $current = $key.GetValue('') } finally { $key.Dispose() }
      if ($current -is [string] -and [string]::Equals($current, $manifest, [StringComparison]::OrdinalIgnoreCase)) { $base.DeleteSubKeyTree($path, $false) }
    }
  } } finally { $base.Dispose() }
}
Write-Output 'HTC connection registrations owned by this directory have been removed.'
` : String.raw`
$data = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
if ($data.name -cne $hostName -or $data.type -cne 'stdio' -or $data.path -ine (Join-Path $PSScriptRoot 'HTC.CollectionHost.exe')) { throw 'Invalid local manifest.' }
# Check every destination before writing any key. Another workspace must explicitly uninstall first.
foreach ($view in $views) {
  $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
  try { foreach ($location in $locations) {
    $key = $base.OpenSubKey($location + $hostName)
    if ($null -ne $key) {
      try { $current = $key.GetValue('') } finally { $key.Dispose() }
      if ($current -isnot [string] -or -not [string]::Equals($current, $manifest, [StringComparison]::OrdinalIgnoreCase)) { throw 'Another workspace owns this host name. Uninstall that connection first.' }
    }
  } } finally { $base.Dispose() }
}
foreach ($view in $views) {
  $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
  try { foreach ($location in $locations) {
    $key = $base.CreateSubKey($location + $hostName)
    try { $key.SetValue('', $manifest, [Microsoft.Win32.RegistryValueKind]::String) } finally { $key.Dispose() }
  } } finally { $base.Dispose() }
}
Write-Output 'HTC connection installed for the current Windows user in Chrome and Edge.'
`);
}

export async function prepareConnectionFiles(dataRoot: string, executable: string, nativeHostName: string): Promise<string> {
  if (process.platform !== 'win32') throw failure();
  const directory = await safeConnectionDirectory(dataRoot, true), owner = JSON.stringify({ version: 1, application: 'HTC.CollectionBridge', directory: canonical(directory) });
  const existing = await readdir(directory);
  if (existing.length && await readFile(await safeFile(directory, 'owner.json'), 'utf8').catch(() => '') !== owner) throw failure();
  const binaryInfo = await lstat(executable); if (!binaryInfo.isFile() || binaryInfo.isSymbolicLink() || binaryInfo.size < 1024 || binaryInfo.size > 2 * 1024 * 1024) throw failure();
  const bytes = await readFile(executable), target = await safeFile(directory, 'HTC.CollectionHost.exe');
  const current = await readFile(target).catch(() => Buffer.alloc(0));
  // Persist ownership before a copied EXE or interrupted ACL helper can make a new
  // directory nonempty. This marker has no secret; token installation still follows ACL setup.
  // Exclusive publication cannot replace an owner that appeared after the empty-directory check.
  if (!existing.length) await writeFileAtomically(await safeFile(await safeConnectionDirectory(dataRoot), 'owner.json'), owner, false);
  if (createHash('sha256').update(current).digest('hex') !== createHash('sha256').update(bytes).digest('hex')) await writeConnectionFile(dataRoot, 'HTC.CollectionHost.exe', bytes);
  await safeConnectionDirectory(dataRoot); await safeFile(directory, 'HTC.CollectionHost.exe');
  await run(target, ['--secure-local-directory'], { windowsHide: true, timeout: 10000, maxBuffer: 4096 });
  await writeConnectionFile(dataRoot, 'native-host.json', JSON.stringify({ name: nativeHostName, description: 'HTC Workbench collection bridge', path: target, type: 'stdio', allowed_origins: [COLLECTION_EXTENSION_ORIGIN] }, null, 2));
  await writeConnectionFile(dataRoot, 'install.ps1', registryScript(nativeHostName, false));
  await writeConnectionFile(dataRoot, 'uninstall.ps1', registryScript(nativeHostName, true));
  return directory;
}
