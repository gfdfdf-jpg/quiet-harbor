import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { getRepoRoot } from '../../../scripts/node-foundation/build';
import { matchAnyRegex } from '../../../src/gate-runtime/text-utils';
import {
    DEFAULT_API_TRIGGER_REGEXES,
    DEFAULT_CODE_LIKE_REGEXES,
    DEFAULT_DB_TRIGGER_REGEXES,
    DEFAULT_DEPENDENCY_TRIGGER_REGEXES,
    DEFAULT_PERFORMANCE_TRIGGER_REGEXES,
    DEFAULT_REFACTOR_PATH_REGEXES,
    DEFAULT_RUNTIME_ROOTS,
    DEFAULT_TEST_PATH_REGEXES,
    DEFAULT_TEST_REFACTOR_STRUCTURAL_PATH_REGEXES,
    LEGACY_MANAGED_PATH_REGEX_DEFAULTS,
    migrateLegacyManagedPathRegexes
} from '../../../src/policy/default-path-regexes';
import { assessReviewRemediationScopeBoundary } from '../../../src/gates/review-remediation/review-remediation-scope-boundary';

const matches = (file: string, regexes: readonly string[]): boolean => matchAnyRegex(file, [...regexes], {
    skipInvalidRegex: false,
    caseInsensitive: true
});

test('default test patterns recognize test conventions across ecosystems', () => {
    for (const file of [
        'pkg/billing/invoice_test.go', 'spec/models/user_spec.rb', 'tests/test_api.py', 'app/test_models.py',
        'billing/invoice_test.py', 'test/billing_test.exs', 'test/widget_test.dart', 'src/test/scala/FooSpec.scala',
        'Tests/AppTests/FooTests.swift', 'Billing.Tests/InvoiceTests.cs', 'Billing.IntegrationTests/Flow.cs',
        'src/commonTest/kotlin/FooTest.kt', 'src/androidInstrumentedTest/java/FooTest.java', 't/basic.t',
        'scripts/Install.Tests.ps1', 'src/parser_unittest.cc', 'src/a.test.ts', 'src/a.spec.jsx', 'e2e/login.ts',
        'apps/server/test/billing_SUITE.erl', 'spec/parser_spec.lua'
    ]) {
        assert.equal(matches(file, DEFAULT_TEST_PATH_REGEXES), true, file);
    }
});

test('default test patterns do not downgrade production code that merely contains test words', () => {
    for (const file of [
        'src/main/java/app/Contest.java', 'src/Latest.cs', 'src/latest/view.ts', 'lib/protest.ex',
        'src/attestation.rs', 'Sources/App/LatestFeed.swift', 'docs/feature.spec.md', 'src/lib.rs',
        'app/models/ab_testing.rb', 'cmd/contest/main.go', 'src/manifest.json'
    ]) {
        assert.equal(matches(file, DEFAULT_TEST_PATH_REGEXES), false, file);
    }
});

test('default test patterns recognize pytest, Go and unambiguous Cucumber support', () => {
    for (const file of [
        'conftest.py', 'src/billing/conftest.py', 'internal/invoice/testdata/case1.json', 'testdata/golden.txt',
        'features/support/env.rb', 'features/support/hooks/world.rb',
        'features/step_definitions/invoice_steps.rb', 'jest.setup.js', 'web/vitest.setup.ts'
    ]) {
        assert.equal(matches(file, DEFAULT_TEST_PATH_REGEXES), true, file);
    }
});

test('RSpec, pytest and Go test patterns keep contracts and production code under their domain reviews', () => {
    for (const file of [
        'spec/openapi.yaml', 'spec/schema.json', 'spec/README.md', 'lib/spec_parser.rb', 'app/models/spec.rb',
        'src/testdata.go', 'src/conftest_utils.py', 'lib/conftest.rb', 'src/features/cart/cart.ts',
        'features/invoices.feature.md', 'jest.config.js'
    ]) {
        assert.equal(matches(file, DEFAULT_TEST_PATH_REGEXES), false, file);
    }
    assert.equal(matches('spec/openapi.yaml', DEFAULT_API_TRIGGER_REGEXES), true);
});

test('feature and framework test layouts do not claim production source folders', () => {
    for (const file of [
        'features/support/SupportChat.tsx', 'features/support/api/tickets.ts', 'features/steps/Checkout.vue',
        'client/features/support/index.ts', 'web/features/support/index.ts', 'packages/web/features/support/index.ts',
        'client/features/steps/index.js', 'web/features/steps/Checkout.vue', 'features/steps/nested/checkout.py',
        'features/steps/workflow.rb', 'features/support/setup.py', 'features/step/cart.js', 'features/support/testdata/view.ts',
        'features/steps/testkit/view.ts', 'features/support/fixtures/presenter.ts', 'features/steps/fixtures/view.ts',
        'client/features/support/qa/helpers/view.ts', 'features/catalog/features/support/fixtures/view.ts',
        'features/catalog/spec/support/order.rb', 'features/catalog/Billing.Specs/Steps/Workflow.cs',
        'packages/web/features/cart/cypress/plugins/index.ts',
        'packages/cypress/features/cart/spec/support/order.rb', 'packages/spec/features/cart/cypress/plugins/index.ts',
        'packages/Billing.Specs/features/cart/spec/support/order.rb',
        'src/features/support/SupportChat.tsx', 'src/app/features/steps/Checkout.vue',
        'packages/web/src/features/step_definitions/Definition.ts', 'lib/features/support/presentation/support_page.dart',
        'apps/mobile/lib/features/steps/checkout.dart', 'Sources/App/features/support/View.swift',
        'src/features/environment.py', 'app/models/spec/definition.rb', 'src/features/spec/fixtures/order.rb',
        'src/features/cypress/tree.ts', 'packages/web/src/cypress/plugins/index.ts',
        'src/features/Billing.Specs/formatter.cs', 'backend/features/steps/workflow.py',
        'src/spec/support/order.rb', 'app/spec/fixtures/loader.rb', 'packages/web/lib/spec/models/order.rb',
        'src/cypress/support/commands.js', 'app/cypress/plugins/index.js',
        'lib/Billing.Spec/Steps/Flow.cs', 'packages/billing/src/Billing.Specs/Steps/Workflow.cs',
        'deep/module/src/features/support/Support.ts', 'packages/web/frontend/features/steps/Page.tsx',
        'internal/features/steps/workflow.go', 'src/main/java/com/shop/features/steps/Checkout.java',
        'src/App/Features/Support/Ticket.cs', 'src/main/java/com/lab/TestCase.java',
        'src/features/testdata/Dashboard.tsx', 'lib/features/testkit/presentation/test_kit.dart',
        'apps/mobile/lib/features/test-support/Dashboard.dart', 'src/features/orders/testdata/Dashboard.tsx',
        'lib/features/support/testkit/presentation/Kits.dart', 'packages/web/src/features/cart/testutils/format.ts'
    ]) {
        assert.equal(matches(file, DEFAULT_TEST_PATH_REGEXES), false, file);
    }
    for (const file of [
        'features/support/env.rb', 'features/steps/login_steps.py', 'features/step_definitions/order_steps.rb',
        'features/support/hooks/world.rb', 'features/step-definitions/cart.js', 'features/step_definitions/cart.ts',
        'features/environment.py',
        'packages/web/features/step_definitions/cart.ts', 'client/features/support/env.rb',
        'apps/api/features/steps/login.py', 'deep/packages/web/features/support/env.rb',
        'internal/orders/testdata/case.json', 'src/testutils/render.ts',
        'spec/models/definition.rb', 'spec/support/order.rb', 'spec/fixtures/invoices.yml',
        'spec/features/support/world.rb', 'client/spec/support/order.rb', 'packages/web/spec/fixtures/loader.rb',
        'cypress/tree.ts', 'cypress/support/commands.js', 'client/cypress/plugins/index.ts',
        'Billing.Spec/format.cs', 'Billing.Specs/format.cs', 'packages/billing/Billing.Specs/Steps/Workflow.cs',
        'packages/features/spec/support/order.rb', 'apps/features/cypress/plugins/index.js',
        'services/features/Billing.Specs/Steps/Flow.cs', 'crates/features/spec/fixtures/invoices.yml'
    ]) {
        assert.equal(matches(file, DEFAULT_TEST_PATH_REGEXES), true, file);
    }
});

test('pytest conftest, Go testdata and shared Rust integration test modules are shared test helpers', () => {
    for (const file of [
        'conftest.py', 'tests/api/conftest.py', 'internal/invoice/testdata/rounding.json', 'tests/common/mod.rs',
        'spec/rails_helper.rb', 'spec/shared_examples/payable.rb', 'spec/shared_contexts/logged_in.rb', 'jest.setup.ts',
        'features/step_definitions/invoice_steps.rb', 'features/steps/login.py', 'features/support/env.rb',
        'cypress/plugins/index.js', 'packages/web/cypress/plugins/index.ts',
        'Billing.Spec/Steps/Flow.cs', 'packages/billing/Billing.Specs/Support/Steps/Workflow.cs'
    ]) {
        assert.equal(matches(file, DEFAULT_TEST_REFACTOR_STRUCTURAL_PATH_REGEXES), true, file);
    }
    for (const file of ['src/common/mod.rs', 'lib/testdata.go', 'src/conftest_utils.py', 'tests/invoice_test.go']) {
        assert.equal(matches(file, DEFAULT_TEST_REFACTOR_STRUCTURAL_PATH_REGEXES), false, file);
    }
});

test('a failed test review may add Cucumber support, conftest or Go testdata during remediation', () => {
    const boundary = assessReviewRemediationScopeBoundary(
        ['spec/models/invoice_spec.rb'],
        ['spec/models/invoice_spec.rb', 'features/support/env.rb', 'tests/conftest.py', 'conftest.py',
            'internal/invoice/testdata/rounding.json'],
        [],
        DEFAULT_TEST_PATH_REGEXES
    );
    assert.equal(boundary.status, 'OK', JSON.stringify(boundary.expandedNonTestFiles));
    assert.deepEqual(boundary.expandedNonTestFiles, []);
});

test('a production feature cannot be added as a test-only scope expansion', () => {
    const boundary = assessReviewRemediationScopeBoundary(
        ['features/steps/login_steps.py'],
        ['features/steps/login_steps.py', 'packages/web/features/step_definitions/cart.ts',
            'src/features/support/SupportChat.tsx', 'features/support/SupportChat.tsx',
            'packages/web/features/support/index.ts', 'spec/support/money.rb'],
        [], DEFAULT_TEST_PATH_REGEXES
    );
    assert.equal(boundary.status, 'BLOCKED');
    assert.deepEqual(boundary.expandedNonTestFiles, [
        'features/support/SupportChat.tsx', 'packages/web/features/support/index.ts', 'src/features/support/SupportChat.tsx'
    ]);
    assert.deepEqual(boundary.allowedTestOnlyExpansionFiles, [
        'packages/web/features/step_definitions/cart.ts', 'spec/support/money.rb'
    ]);
});

test('default dependency patterns cover manifests and lockfiles of common ecosystems', () => {
    for (const file of [
        'package.json', 'pnpm-lock.yaml', 'bun.lockb', 'deno.json', 'pom.xml', 'gradle/libs.versions.toml',
        'build.sbt', 'requirements-dev.txt', 'uv.lock', 'Pipfile.lock', 'setup.py', 'go.work', 'Cargo.lock',
        'composer.lock', 'app.gemspec', 'src/App/App.csproj', 'Directory.Packages.props', 'packages.lock.json',
        'Package.swift', 'Package.resolved', 'Podfile.lock', 'pubspec.yaml', 'mix.lock', 'rebar.config',
        'app.cabal', 'stack.yaml', 'deps.edn', 'Project.toml', 'renv.lock', 'CMakeLists.txt', 'vcpkg.json',
        'conanfile.txt', 'MODULE.bazel', 'build.zig.zon', 'flake.lock', 'services/api/go.mod'
    ]) {
        assert.equal(matches(file, DEFAULT_DEPENDENCY_TRIGGER_REGEXES), true, file);
    }
    for (const file of ['src/package.ts', 'docs/dependencies.md', 'src/Podfile.swift']) {
        assert.equal(matches(file, DEFAULT_DEPENDENCY_TRIGGER_REGEXES), false, file);
    }
});

test('domain triggers apply to source files of any common language without generic substring noise', () => {
    assert.equal(matches('lib/app/user_repository.ex', DEFAULT_DB_TRIGGER_REGEXES), true);
    assert.equal(matches('Sources/App/UserRepository.swift', DEFAULT_DB_TRIGGER_REGEXES), true);
    assert.equal(matches('src/vector_connector.rs', DEFAULT_DB_TRIGGER_REGEXES), false);
    assert.equal(matches('src/reporter.go', DEFAULT_DB_TRIGGER_REGEXES), false);
    assert.equal(matches('lib/web/user_controller.ex', DEFAULT_API_TRIGGER_REGEXES), true);
    assert.equal(matches('src/main/scala/UserDto.scala', DEFAULT_API_TRIGGER_REGEXES), true);
    assert.equal(matches('proto/billing.proto', DEFAULT_API_TRIGGER_REGEXES), true);
    assert.equal(matches('src/SearchIndex.dart', DEFAULT_PERFORMANCE_TRIGGER_REGEXES), true);
    assert.equal(matches('src/AppConfig.swift', DEFAULT_REFACTOR_PATH_REGEXES), true);
    for (const file of ['lib/x.ex', 'Sources/App/main.swift', 'src/main.c', 'include/a.hpp', 'lib/main.dart', 'src/lib.zig']) {
        assert.equal(matches(file, DEFAULT_CODE_LIKE_REGEXES), true, file);
    }
});

test('materialized paths template matches the shared stack-neutral defaults', () => {
    const template = JSON.parse(fs.readFileSync(path.join(getRepoRoot(), 'template', 'config', 'paths.json'), 'utf8'));
    assert.deepEqual(template.runtime_roots, DEFAULT_RUNTIME_ROOTS);
    assert.deepEqual(template.code_like_regexes, DEFAULT_CODE_LIKE_REGEXES);
    assert.deepEqual(template.triggers.test, DEFAULT_TEST_PATH_REGEXES);
    assert.deepEqual(template.triggers.test_refactor_structural, DEFAULT_TEST_REFACTOR_STRUCTURAL_PATH_REGEXES);
    assert.deepEqual(template.triggers.refactor, DEFAULT_REFACTOR_PATH_REGEXES);
    assert.deepEqual(template.triggers.db, DEFAULT_DB_TRIGGER_REGEXES);
    assert.deepEqual(template.triggers.api, DEFAULT_API_TRIGGER_REGEXES);
    assert.deepEqual(template.triggers.dependency, DEFAULT_DEPENDENCY_TRIGGER_REGEXES);
    assert.deepEqual(template.triggers.performance, DEFAULT_PERFORMANCE_TRIGGER_REGEXES);
});

test('all round-2 test and feature patterns remain unchanged before the restored layouts', () => {
    const previous = JSON.parse(fs.readFileSync(
        path.join(getRepoRoot(), 'tests/node/materialization/fixtures/round-2-path-defaults.json'), 'utf8'
    ));
    assert.deepEqual(DEFAULT_TEST_PATH_REGEXES.slice(0, previous.test.length), previous.test);
    assert.deepEqual(DEFAULT_TEST_REFACTOR_STRUCTURAL_PATH_REGEXES.slice(0, previous.test_refactor_structural.length),
        previous.test_refactor_structural);
});

test('update migrates only uncustomized legacy managed path patterns', () => {
    const template = JSON.parse(fs.readFileSync(path.join(getRepoRoot(), 'template', 'config', 'paths.json'), 'utf8'));
    const customTest = ['(^|/)quality/'];
    const merged = {
        runtime_roots: [...LEGACY_MANAGED_PATH_REGEX_DEFAULTS.runtime_roots[0]],
        code_like_regexes: [...LEGACY_MANAGED_PATH_REGEX_DEFAULTS.code_like_regexes[0]],
        triggers: {
            dependency: [...LEGACY_MANAGED_PATH_REGEX_DEFAULTS['triggers.dependency'][0]],
            test: customTest,
            db: [...LEGACY_MANAGED_PATH_REGEX_DEFAULTS['triggers.db'][0], '(^|/)custom-db/']
        }
    };
    const migrated = migrateLegacyManagedPathRegexes(merged, template);
    assert.deepEqual(migrated.sort(), ['code_like_regexes', 'runtime_roots', 'trigger_name_tokens', 'triggers.dependency', 'untracked_build_output_regexes']);
    assert.deepEqual((merged as Record<string, unknown>).untracked_build_output_regexes, template.untracked_build_output_regexes);
    assert.deepEqual((merged as Record<string, unknown>).trigger_name_tokens, template.trigger_name_tokens);
    assert.deepEqual(merged.runtime_roots, DEFAULT_RUNTIME_ROOTS);
    assert.deepEqual(merged.code_like_regexes, DEFAULT_CODE_LIKE_REGEXES);
    assert.deepEqual(merged.triggers.dependency, DEFAULT_DEPENDENCY_TRIGGER_REGEXES);
    assert.equal(merged.triggers.test, customTest);
    assert.equal(merged.triggers.db.at(-1), '(^|/)custom-db/');
});

test('update upgrades the uncustomized 1.4.3 infra trigger list and keeps configured name tokens', () => {
    const template = JSON.parse(fs.readFileSync(path.join(getRepoRoot(), 'template', 'config', 'paths.json'), 'utf8'));
    const customTokens = { security: ['shield'] };
    const merged = {
        trigger_name_tokens: customTokens,
        triggers: { infra: [...LEGACY_MANAGED_PATH_REGEX_DEFAULTS['triggers.infra'][0]] }
    };
    const migrated = migrateLegacyManagedPathRegexes(merged, template);
    assert.ok(migrated.includes('triggers.infra'));
    assert.ok(!migrated.includes('trigger_name_tokens'));
    assert.deepEqual(merged.triggers.infra, template.triggers.infra);
    assert.equal(merged.trigger_name_tokens, customTokens);
});

test('update upgrades the uncustomized 1.4.3 shared test helper list and keeps a customized one', () => {
    const template = JSON.parse(fs.readFileSync(path.join(getRepoRoot(), 'template', 'config', 'paths.json'), 'utf8'));
    const previous = [
        '(^|/)(?:__fixtures__|fixtures?|__mocks__|mocks?|helpers?|harness|support|setup|factories|factory|snapshots?)(?:/|\\.|-|_|$)',
        '(?:test|spec)[-_]?(?:helpers?|fixtures?|harness|support|setup|factories?|mocks?)',
        '(?:helpers?|fixtures?|harness|support|setup|factories?|mocks?)[-_]?(?:test|spec)'
    ];
    const merged = { triggers: { test_refactor_structural: previous } };
    assert.ok(migrateLegacyManagedPathRegexes(merged, template).includes('triggers.test_refactor_structural'));
    assert.deepEqual(merged.triggers.test_refactor_structural, DEFAULT_TEST_REFACTOR_STRUCTURAL_PATH_REGEXES);
    const customized = { triggers: { test_refactor_structural: [...previous, '(^|/)quality/'] } };
    assert.ok(!migrateLegacyManagedPathRegexes(customized, template).includes('triggers.test_refactor_structural'));
    assert.equal(customized.triggers.test_refactor_structural.at(-1), '(^|/)quality/');
});

test('update upgrades uncustomized 1.4.3 and 1.4.4 candidate test trigger lists to the current defaults', () => {
    const template = JSON.parse(fs.readFileSync(path.join(getRepoRoot(), 'template', 'config', 'paths.json'), 'utf8'));
    const codeExtensions = 'java|kt|kts|groovy|scala|sc|clj|cljs|cljc|ts|tsx|js|jsx|cjs|mjs|vue|svelte'
        + '|cs|fs|vb|go|py|rb|php|rs|swift|m|mm|c|cc|cpp|cxx|h|hh|hpp|hxx|ex|exs|erl|hrl|dart|lua|hs|ml|mli'
        + '|jl|r|nim|zig|cr|pl|pm|sh|bash|ps1|psm1';
    const candidateList = [
        '/src/test/',
        '(^|/)(__tests__|tests?)/',
        '(^|/)src/(?:common|jvm|js|native|android|androidUnit|androidInstrumented|ios|desktop|wasmJs|wasmWasi|integration|functional|unit)Test/',
        '(^|/)[^/]+\\.(?:unit|integration|functional|acceptance|component|e2e)?tests?/',
        '(^|/)e2e/',
        `\\.(spec|test)\\.(?:${codeExtensions})$`,
        '_test\\.(?:go|py|exs|dart|cc|cpp|cxx|c|lua|cr|nim|zig|jl)$',
        '_unittest\\.(?:cc|cpp|cxx|c)$',
        '_spec\\.(?:rb|lua|cr|exs|js|ts)$',
        '(^|/)test_[^/]+\\.py$',
        '(^|/)t/[^/]+\\.t$',
        '\\.tests\\.ps1$',
        '_SUITE\\.erl$'
    ];
    const release143List = [
        '/src/test/', '(^|/)(__tests__|tests?)/', '\\.(spec|test)\\.(ts|tsx|js|jsx|java|kt|go|py|rb|php)$'
    ];
    for (const previous of [release143List, candidateList]) {
        const merged = { triggers: { test: previous } };
        assert.ok(migrateLegacyManagedPathRegexes(merged, template).includes('triggers.test'));
        assert.deepEqual(merged.triggers.test, DEFAULT_TEST_PATH_REGEXES);
    }
    for (const previous of [release143List, candidateList]) {
        const customized = { triggers: { test: [...previous, '(^|/)quality/'] } };
        assert.ok(!migrateLegacyManagedPathRegexes(customized, template).includes('triggers.test'));
        assert.equal(customized.triggers.test.at(-1), '(^|/)quality/');
    }
});
