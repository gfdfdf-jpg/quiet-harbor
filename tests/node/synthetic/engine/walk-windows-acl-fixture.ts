import * as fs from 'node:fs';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import { getWindowsNativeEnvironment, getWindowsSystemDirectory, WINDOWS_NATIVE_POWERSHELL_BOOTSTRAP } from '../../../../src/core/windows-native-environment';

const SCRIPT = WINDOWS_NATIVE_POWERSHELL_BOOTSTRAP + `
$ErrorActionPreference = 'Stop'
$target = $env:GARDA_WALK_EMPTY_ROOT
$item = [IO.DirectoryInfo]::new($target)
if (-not $item.Exists -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Redirected walk root' }
if (@([IO.Directory]::EnumerateFileSystemEntries($target)).Count -ne 0) { throw 'Walk root is not empty' }
$original = Microsoft.PowerShell.Security\\Get-Acl -LiteralPath $target
$owner = $original.GetOwner([Security.Principal.SecurityIdentifier]).Value
$group = $original.GetGroup([Security.Principal.SecurityIdentifier]).Value
$acl = [IO.Directory]::GetAccessControl($target, [Security.AccessControl.AccessControlSections]::Access)
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ($owner -ne $sid -and $owner -ne 'S-1-5-32-544') { throw 'Walk root has a foreign owner' }
# Only the fresh disposable root DACL changes. Keep its owner, group and SACL.
$acl.SetAccessRuleProtection($true, $false)
foreach ($entry in @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))) { $acl.RemoveAccessRuleSpecific($entry) }
$trusted = @($sid, 'S-1-5-18', 'S-1-5-32-544') | Microsoft.PowerShell.Utility\\Select-Object -Unique
foreach ($principal in $trusted) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new($principal),
        [Security.AccessControl.FileSystemRights]::FullControl,
        [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
}
[IO.Directory]::SetAccessControl($target, $acl)
$actual = Microsoft.PowerShell.Security\\Get-Acl -LiteralPath $target
if (-not $actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $owner -or
    $actual.GetGroup([Security.Principal.SecurityIdentifier]).Value -ne $group) { throw 'Walk root ACL identity changed' }
$entries = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
if ($entries.Count -ne $trusted.Count) { throw 'Walk root ACL entry count differs' }
$seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach ($entry in $entries) {
    if (-not $seen.Add($entry.IdentityReference.Value)) { throw 'Duplicate walk root principal' }
    if ($trusted -notcontains $entry.IdentityReference.Value -or $entry.IsInherited -or
        $entry.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
        $entry.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
        $entry.InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' -or
        $entry.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) { throw 'Unexpected walk root ACL entry' }
}
[Console]::WriteLine('walk-inherited-acl-ready')
`;

/** Stand input, not product policy: copied/new descendants inherit the same trusted ACL on every Windows host.
 * Called once on a fresh empty fixture, before copying its template. Never repairs ACL changes during a walk. */
export function prepareEmptyWalkWindowsAcl(root: string): void {
    if (process.platform !== 'win32') return;
    const absolute = path.resolve(root), before = fs.lstatSync(absolute, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() || !/^garda-walk-[A-Za-z0-9]+$/u.test(path.basename(absolute))
        || fs.realpathSync.native(absolute) !== absolute || fs.readdirSync(absolute).length !== 0) {
        throw new Error('Windows walk ACL setup requires a fresh empty native fixture directory.');
    }
    const result = childProcess.spawnSync(path.join(getWindowsSystemDirectory(), 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
        { env: { ...getWindowsNativeEnvironment(), GARDA_WALK_EMPTY_ROOT: absolute }, encoding: 'utf8', windowsHide: true,
            timeout: 10_000, maxBuffer: 256 * 1024 });
    if (result.status !== 0 || result.error || result.stdout.trim() !== 'walk-inherited-acl-ready')
        throw new Error('Windows walk ACL fixture setup failed: ' + String(result.error || result.stderr || result.stdout));
    const after = fs.lstatSync(absolute, { bigint: true });
    if (!after.isDirectory() || after.isSymbolicLink() || fs.realpathSync.native(absolute) !== absolute
        || before.dev !== after.dev || before.ino !== after.ino || before.birthtimeNs !== after.birthtimeNs
        || fs.readdirSync(absolute).length !== 0) throw new Error('Windows walk root changed during ACL setup.');
}
