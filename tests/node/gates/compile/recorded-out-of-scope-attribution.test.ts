import test from 'node:test';
import assert from 'node:assert/strict';
import { displayableFailureReferences, recordedFailureAttributionText } from '../../../../src/gates/full-suite/recorded-out-of-scope-failures';

test('opaque legacy references and mixed lists are never displayed as confirmed failing tests', () => {
    for (const refs of [[], ['14:19:54.151'], ['java.lang.RuntimeException'], ['org.apache.maven.plugins'],
        ['tests/real.case', '14:19:54.151'], ['../tests/escaped.case'], ['/tests/absolute.case'], ['C:/tests/absolute.case'],
        ['tests/../escaped.case'], ['tests//ambiguous.case'], ['tests/line\nfeed.case'], ['tests/pipe|cell.case'],
        ['tests\\windows.case']]) {
        assert.equal(displayableFailureReferences(refs), null);
        assert.match(recordedFailureAttributionText(refs), /^Tests: not attributed/u);
        assert.doesNotMatch(recordedFailureAttributionText(refs), /Failing tests:|14:19|RuntimeException/u);
    }
});

test('relative references remain informational and technology independent without changing their bytes', () => {
    const refs = ['tests/widget.test.cjs', 'backend/src/test/java/Example.java', 'odd/custom suite.unknown'];
    const before = JSON.stringify(refs);
    assert.equal(displayableFailureReferences(refs), refs);
    assert.equal(recordedFailureAttributionText(refs), `Reported failure references (informational): ${refs.join(', ')}`);
    assert.equal(JSON.stringify(refs), before);
});
