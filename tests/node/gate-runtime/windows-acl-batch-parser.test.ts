import test from 'node:test';
import assert from 'node:assert/strict';
import { aclEvidenceBytes, parseAclEntries } from '../../../src/gate-runtime/timeline/windows-acl-batch';

const files = ['C:\\fixture\\a.txt', 'C:\\fixture\\a.txt extra'];
const record = (file: string) => Buffer.concat([
    Buffer.from(file + ' SYSTEM:(F)\n' + ' '.repeat(file.length + 1)),
    Buffer.from([0xff, 0xfe]), Buffer.from(':(I)(R)\n')
]);
const complete = (entries: Buffer[], trailer = 'Successfully processed 2 files; Failed processing 0 files') =>
    Buffer.concat([...entries.flatMap(entry => [entry, Buffer.from('\n')]), Buffer.from(trailer + '\r\n')]);

test('grouped ACL records retain original bytes and match individual evidence across localized trailers', () => {
    const first = record(files[0]), second = record(files[1]);
    for (const trailer of ['Successfully processed 2 files; Failed processing 0 files',
        'Обработано 2 файлов; ошибки 0 файлов']) {
        const parsed = parseAclEntries(complete([first, second], trailer), files);
        assert.ok(parsed);
        assert.deepEqual(parsed.get(files[0]), first);
        assert.deepEqual(parsed.get(files[1]), second);
        const point = complete([first], 'Successfully processed 1 files; Failed processing 0 files');
        assert.deepEqual(parsed.get(files[0]), aclEvidenceBytes(files[0], point));
    }
});

test('incomplete, duplicated, extra or failed ACL group responses are never authority', () => {
    const first = record(files[0]), second = record(files[1]), valid = complete([first, second]);
    for (const bytes of [complete([first]), complete([first, first]), complete([first, second, record('C:\\fixture\\extra')]),
        complete([first, second], 'Successfully processed 2 files; Failed processing 1 files'),
        valid.subarray(0, valid.length - 1), Buffer.concat([valid, Buffer.from('extra 2 0\n')]),
        complete([Buffer.from(files[0] + ' invalid\n'), second])]) assert.equal(parseAclEntries(bytes, files), null);
    assert.equal(parseAclEntries(valid, [files[0], 'C:\\fixture\\кириллица']), null);
});
