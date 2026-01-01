import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import { prepareEmptyWalkWindowsAcl } from './engine/walk-windows-acl-fixture';
import { getWindowsNativeEnvironment, getWindowsSystemDirectory, WINDOWS_NATIVE_POWERSHELL_BOOTSTRAP } from '../../../src/core/windows-native-environment';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../src/core/next-step-measurement';
import { assertInvocationDependenciesCurrent, withInvocationReadObservation } from '../../../src/core/invocation-read-observation';
import { inspectTrustedWindowsWriteAuthority } from '../../../src/gate-runtime/timeline/windows-acl-authority';

const windowsOnly = { skip: process.platform !== 'win32' ? 'Native Windows ACL fixture inputs require Windows.' : false };
function native(script: string, target: string): string {
    const result = childProcess.spawnSync(path.join(getWindowsSystemDirectory(), 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_NATIVE_POWERSHELL_BOOTSTRAP + script, 'utf16le').toString('base64')],
        { env: { ...getWindowsNativeEnvironment(), GARDA_ACL_TEST_TARGET: target }, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    assert.equal(result.status, 0, String(result.error || result.stderr));
    return result.stdout.trim();
}
function descriptor(target: string): string {
    return native('[Console]::Write((Microsoft.PowerShell.Security\\Get-Acl -LiteralPath $env:GARDA_ACL_TEST_TARGET).Sddl)', target);
}
function ownerAndGroup(target: string): string {
    return native('[Console]::Write((Microsoft.PowerShell.Security\\Get-Acl -LiteralPath $env:GARDA_ACL_TEST_TARGET).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]"Owner,Group"))', target);
}
function grant(target: string, sid: string, remove = false): void {
    const result = childProcess.spawnSync(path.join(getWindowsSystemDirectory(), 'icacls.exe'),
        remove ? [target, '/remove:g', '*' + sid] : [target, '/grant', '*' + sid + ':(W)'],
        { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
    assert.equal(result.status, 0, String(result.error || result.stderr || result.stdout));
}

test('Windows walk input DACL is confined to its empty root; copied and new children inherit trusted grants', windowsOnly, t => {
    const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'garda-walk-acl-input-')));
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    const root = fs.mkdtempSync(path.join(parent, 'garda-walk-'));
    const sibling = path.join(parent, 'unrelated'), template = path.join(parent, 'template');
    fs.mkdirSync(sibling); fs.mkdirSync(path.join(template, 'runtime', 'task-events'), { recursive: true });
    fs.mkdirSync(path.join(template, 'runtime', 'reviews'));
    fs.writeFileSync(path.join(template, 'runtime', 'task-events', 'T-WALK.jsonl'), '{}\n');
    const outsideBefore = [descriptor(parent), descriptor(sibling), descriptor(template)];
    const ownerBefore = ownerAndGroup(root);
    prepareEmptyWalkWindowsAcl(root);
    fs.cpSync(template, root, { recursive: true });
    const file = path.join(root, 'runtime', 'reviews', 'T-WALK-task-mode.json');
    fs.writeFileSync(file, '{}\n');
    const targets = [path.join(root, 'runtime', 'task-events'), path.join(root, 'runtime', 'task-events', 'T-WALK.jsonl'), path.dirname(file), file];
    for (const target of targets) {
        const entries = JSON.parse(native(`
$ErrorActionPreference = 'Stop'
$acl = Microsoft.PowerShell.Security\\Get-Acl -LiteralPath $env:GARDA_ACL_TEST_TARGET
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$trusted = @($sid, 'S-1-5-18', 'S-1-5-32-544') | Microsoft.PowerShell.Utility\\Select-Object -Unique
$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne $trusted.Count) { throw 'Unexpected inherited fixture ACL count' }
$seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach ($rule in $rules) {
    if (-not $seen.Add($rule.IdentityReference.Value)) { throw 'Duplicate inherited fixture principal' }
    if (-not $rule.IsInherited -or $trusted -notcontains $rule.IdentityReference.Value -or
        $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
        $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl) { throw 'Unexpected inherited fixture ACL' }
}
[Console]::Write('true')
`, target));
        assert.equal(entries, true);
    }
    assert.equal(ownerAndGroup(root), ownerBefore);
    assert.deepEqual([descriptor(parent), descriptor(sibling), descriptor(template)], outsideBefore);
    let measured: NextStepMeasurement | undefined;
    withNextStepMeasurement(() => withInvocationReadObservation(() => {
        for (const target of targets) assert.equal(inspectTrustedWindowsWriteAuthority(target), true);
    }), value => { measured = value; });
    for (const target of targets) for (const phase of ['initial', 'final'])
        assert.equal(measured!.work['acl_probe:' + phase + ':' + target], 1, 'Inherited inputs retain every ACL observation');
    assert.equal(measured!.work['acl_principal_probe:initial'] ?? 0, 0);
    assert.equal(measured!.work['acl_principal_probe:final'] ?? 0, 0);
    assert.throws(() => prepareEmptyWalkWindowsAcl(root), /fresh empty/u, 'Setup cannot erase a later ACL mutation');

    const sid = native('[Console]::Write([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)', file);
    grant(file, sid);
    withNextStepMeasurement(() => withInvocationReadObservation(() => {
        assert.equal(inspectTrustedWindowsWriteAuthority(file), true);
        assertInvocationDependenciesCurrent();
    }), value => { measured = value; });
    assert.equal(measured!.work['acl_principal_probe:initial'], 1, 'Explicit trusted writes still require a fresh principal');
    assert.equal(measured!.work['acl_principal_probe:final'], 2, 'Revalidation and final publication each require a fresh principal');
    grant(file, sid, true);
    try {
        assert.throws(() => withInvocationReadObservation(() => {
            assert.equal(inspectTrustedWindowsWriteAuthority(file), true);
            grant(file, 'S-1-1-0');
        }), /Invocation Windows ACL observation changed/u);
        assert.equal(withInvocationReadObservation(() => inspectTrustedWindowsWriteAuthority(file)), false, 'Untrusted explicit writes are rejected');
    } finally { grant(file, 'S-1-1-0', true); }
    assert.equal(withInvocationReadObservation(() => inspectTrustedWindowsWriteAuthority(file)), true);
    assert.deepEqual([descriptor(parent), descriptor(sibling), descriptor(template)], outsideBefore);
});

test('Windows walk input setup rejects nonempty directories, files and redirected paths before ACL changes', windowsOnly, t => {
    const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'garda-walk-acl-refusals-')));
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    const root = fs.mkdtempSync(path.join(parent, 'garda-walk-')), file = path.join(root, 'keep.txt');
    fs.writeFileSync(file, 'preserve');
    const before = descriptor(root);
    assert.throws(() => prepareEmptyWalkWindowsAcl(root), /fresh empty/u);
    assert.throws(() => prepareEmptyWalkWindowsAcl(file), /fresh empty/u);
    const redirect = path.join(parent, 'garda-walk-Redirect');
    fs.symlinkSync(root, redirect, 'junction');
    assert.throws(() => prepareEmptyWalkWindowsAcl(redirect), /fresh empty/u);
    assert.equal(descriptor(root), before);
    assert.equal(fs.readFileSync(file, 'utf8'), 'preserve');
});
