import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewRemediationDeltaInternals } from '../../../../src/gates/review-remediation/review-remediation-delta';
import { DEFAULT_REVIEW_TRIGGER_POLICY } from '../../../../src/policy/review-trigger-policy';

const structuralPatterns = reviewRemediationDeltaInternals.compilePatterns(
    DEFAULT_REVIEW_TRIGGER_POLICY.test_refactor_structural_path_regexes, 'structural test path regexes'
);

function categoryOf(filePath: string, operation: 'modified' | 'added' = 'modified'): string {
    return reviewRemediationDeltaInternals.categorizeFile({
        filePath,
        operation,
        changedLines: 10,
        lineDeltaUnavailableReason: null,
        baselineStatus: 'text',
        currentStatus: 'text',
        testPathRegexes: DEFAULT_REVIEW_TRIGGER_POLICY.test_path_regexes,
        structuralPatterns,
        structuralThreshold: DEFAULT_REVIEW_TRIGGER_POLICY.test_refactor_changed_lines_threshold
    }).category;
}

test('production features and source directories remain production when modified or added', () => {
    for (const file of [
        'features/support/SupportChat.tsx', 'features/support/api/tickets.ts', 'features/steps/Checkout.vue',
        'client/features/support/index.ts', 'web/features/support/index.ts', 'packages/web/features/support/index.ts',
        'client/features/steps/index.js', 'web/features/steps/Checkout.vue', 'features/steps/nested/checkout.py',
        'features/steps/workflow.rb', 'features/support/setup.py', 'features/step/cart.js', 'features/support/testdata/view.ts',
        'features/steps/testkit/view.ts', 'features/support/fixtures/presenter.ts', 'features/steps/fixtures/view.ts',
        'client/features/support/qa/helpers/view.ts', 'features/catalog/features/support/fixtures/view.ts',
        'features/support/TestService.ts', 'features/support/SupportTestsDashboard.tsx',
        'features/catalog/spec/support/order.rb', 'features/catalog/Billing.Specs/Steps/Workflow.cs',
        'packages/web/features/cart/cypress/plugins/index.ts',
        'packages/cypress/features/cart/spec/support/order.rb', 'packages/spec/features/cart/cypress/plugins/index.ts',
        'packages/Billing.Specs/features/cart/spec/support/order.rb',
        'src/features/support/SupportChat.tsx', 'src/features/support/api/tickets.ts',
        'src/app/features/steps/Checkout.vue', 'lib/features/support/presentation/support_page.dart',
        'apps/mobile/lib/features/steps/checkout.dart', 'Sources/App/features/support/View.swift',
        'packages/web/src/features/step_definitions/Definition.ts', 'src/features/environment.py',
        'app/models/spec/definition.rb', 'app/models/spec/support/order.rb', 'app/models/spec/fixtures/order.rb',
        'src/features/spec/support/order.rb', 'src/features/spec/fixtures/order.rb',
        'src/features/cypress/tree.ts', 'packages/web/src/cypress/plugins/index.ts',
        'src/features/Billing.Specs/formatter.cs', 'backend/features/steps/workflow.py',
        'src/spec/support/order.rb', 'app/spec/fixtures/loader.rb', 'packages/web/lib/spec/models/order.rb',
        'src/cypress/support/commands.js', 'app/cypress/plugins/index.js',
        'lib/Billing.Spec/Steps/Flow.cs', 'packages/billing/src/Billing.Specs/Steps/Workflow.cs',
        'deep/module/src/features/support/Support.ts', 'src/main/java/com/lab/TestCase.java',
        'src/features/support/TestBase.ts', 'src/features/support/TestService.ts',
        'src/features/support/SupportTestsDashboard.tsx', 'lib/medical/BaseBloodTest.dart',
        'internal/features/steps/workflow.go', 'src/main/java/com/shop/features/steps/Checkout.java',
        'src/App/Features/Support/Ticket.cs', 'src/features/testdata/Dashboard.tsx',
        'lib/features/testkit/presentation/test_kit.dart', 'apps/mobile/lib/features/test-support/Dashboard.dart',
        'src/features/orders/testdata/Dashboard.tsx', 'lib/features/support/testkit/presentation/Kits.dart',
        'packages/web/src/features/cart/testutils/format.ts'
    ]) {
        assert.equal(categoryOf(file), 'production', file);
        assert.equal(categoryOf(file, 'added'), 'production', file);
    }
});

test('root and package framework files follow leaf and shared helper remediation rules', () => {
    for (const file of [
        'spec/models/definition.rb', 'cypress/tree.ts', 'Billing.Spec/format.cs',
        'Billing.Specs/format.cs', 'packages/billing/Billing.Specs/format.cs'
    ]) {
        assert.equal(categoryOf(file), 'leaf_test', file);
        assert.equal(categoryOf(file, 'added'), 'leaf_test', file);
    }
    for (const file of [
        'spec/support/order.rb', 'spec/spec_helper.rb', 'spec/fixtures/invoices.yml',
        'spec/factories/users.rb', 'spec/features/support/world.rb', 'client/spec/support/order.rb',
        'packages/web/spec/fixtures/loader.rb', 'cypress/support/commands.js', 'cypress/plugins/index.js',
        'client/cypress/plugins/index.ts', 'Billing.Spec/Steps/Flow.cs', 'Billing.Specs/Steps/FooSteps.cs',
        'packages/billing/Billing.Specs/Support/Steps/Workflow.cs', 'packages/features/spec/support/order.rb',
        'apps/features/cypress/plugins/index.js', 'services/features/Billing.Specs/Steps/Flow.cs',
        'crates/features/spec/fixtures/invoices.yml'
    ]) {
        assert.equal(categoryOf(file), 'shared_test_helper_or_harness', file);
        assert.equal(categoryOf(file, 'added'), 'leaf_test', file);
    }
});

test('Cucumber and behave support remain shared test helpers, with new files treated as leaf tests', () => {
    for (const file of [
        'features/support/env.rb', 'features/steps/login_steps.py', 'features/environment.py',
        'features/support/hooks/world.rb', 'features/step_definitions/invoice_steps.rb',
        'features/step-definitions/cart.js', 'features/step_definitions/cart.ts', 'packages/web/features/step_definitions/cart.ts',
        'apps/api/features/steps/login.py', 'deep/packages/web/features/support/env.rb'
    ]) {
        assert.equal(categoryOf(file), 'shared_test_helper_or_harness', file);
        assert.equal(categoryOf(file, 'added'), 'leaf_test', file);
    }
    assert.equal(categoryOf('src/features/support/SupportChat.test.tsx', 'added'), 'leaf_test');
    assert.equal(categoryOf('src/features/cart/testutils/render.test.ts', 'added'), 'leaf_test');
    assert.equal(categoryOf('src/features/cart/__mocks__/api.ts'), 'shared_test_helper_or_harness');
    assert.equal(categoryOf('src/features/cart/setupTests.ts'), 'shared_test_helper_or_harness');
});

test('configured Cucumber-JS support remains a test and shared helper', () => {
    const filePath = 'client/features/support/env.ts';
    const categorize = (operation: 'modified' | 'added'): string => reviewRemediationDeltaInternals.categorizeFile({
        filePath, operation, changedLines: 10, lineDeltaUnavailableReason: null, baselineStatus: 'text', currentStatus: 'text',
        testPathRegexes: [...DEFAULT_REVIEW_TRIGGER_POLICY.test_path_regexes, '(^|/)features/support/'],
        structuralPatterns, structuralThreshold: DEFAULT_REVIEW_TRIGGER_POLICY.test_refactor_changed_lines_threshold
    }).category;
    assert.equal(categorize('modified'), 'shared_test_helper_or_harness');
    assert.equal(categorize('added'), 'leaf_test');
});

test('project test patterns opt source-root framework layouts into test remediation', () => {
    const testPathRegexes = [...DEFAULT_REVIEW_TRIGGER_POLICY.test_path_regexes,
        '(^|/)spec/', '(^|/)cypress/', '(^|/)[^/]+\\.Specs/'];
    for (const filePath of ['app/spec/support/money.rb', 'src/cypress/plugins/index.js', 'src/Billing.Specs/Steps/Flow.cs']) {
        const category = reviewRemediationDeltaInternals.categorizeFile({
            filePath, operation: 'added', changedLines: 10, lineDeltaUnavailableReason: null,
            baselineStatus: 'text', currentStatus: 'text', testPathRegexes, structuralPatterns,
            structuralThreshold: DEFAULT_REVIEW_TRIGGER_POLICY.test_refactor_changed_lines_threshold
        }).category;
        assert.equal(category, 'leaf_test', filePath);
    }
});

test('source files outside src, bin and scripts are production code on every stack', () => {
    for (const file of [
        'app/models/invoice.rb', 'lib/orders/invoice.ex', 'internal/invoice/invoice.go', 'cmd/orders/main.go',
        'orders/invoice.py', 'Sources/Orders/Invoice.swift', 'crates/orders/src/invoice.rs',
        'migrations/0001_init.sql', 'db/migrate/20240101000000_create_invoices.rb', 'web/index.html',
        'src/infrastructure/invoice-repository.ts'
    ]) {
        assert.equal(categoryOf(file), 'production', file);
    }
});

test('unowned configuration requires FULL while protected manifests and infrastructure have owners', () => {
    for (const file of [
        'src/Orders/appsettings.json', 'src/Orders/Orders.csproj', 'src/Orders/web.config',
        'src/main/resources/application.yml', 'src/main/resources/application.conf', 'config/config.exs',
        'config/orders.php', 'orders/settings.py', 'vite.config.ts', '.eslintrc.js', '.env.production',
        'mix.exs', 'Package.swift', 'build.gradle.kts', 'setup.py', 'Cargo.toml', 'karma.conf.js', 'jest.config.js',
        'config/setup.yml', '.github/workflows/setup.yml', 'packages/test-helpers/package.json',
        'apps/shop/config/environments/production.rb', 'src/config/app.yml', 'project/settings/production.py',
        'cypress/package.json', 'tests/package.json', '.github/workflows/test.yml', 'api/openapi.yaml', '.env.example'
    ]) {
        const protectedFile = /(?:csproj|mix\.exs|Package\.swift|build\.gradle\.kts|setup\.py|Cargo\.toml|package\.json|\.github\/workflows|\.env\.|api\/openapi\.yaml)/u.test(file);
        assert.equal(categoryOf(file), protectedFile ? 'production' : 'global', file);
    }
});

test('documentation re-opens every review wherever it lives, including under source roots', () => {
    for (const file of [
        'src/README.md', 'src/docs/guide.md', 'CONTRIBUTING.md', 'docs/setup.md', 'docs/support/faq.md', 'LICENSE',
        'docs/test-setup.md', 'docs/test_helpers.md', 'docs/jest.setup.md', 'docs/tests/guide.md',
        'src/docs/index.html', 'packages/ui/docs/example.ts', 'doc/guide.rb'
    ]) {
        assert.equal(categoryOf(file), 'global', file);
    }
    assert.equal(categoryOf('tests/README.md'), 'leaf_test');
});

test('generated files and build output re-open every review even with source extensions', () => {
    for (const file of [
        'internal/gen/invoice.pb.go', 'service/obj/Debug/App.g.cs', 'orders/invoice_pb2.py', 'web/client_pb.js',
        'src/Orders/Invoice.Designer.cs', 'lib/models.freezed.dart', 'api/zz_generated.deepcopy.go', 'api/schema.gen.ts',
        'target/generated-sources/Invoice.java', 'build/generated/Invoice.kt', '_build/dev/lib/invoice.ex',
        'vendor/acme/Invoice.php', 'node_modules/left-pad/index.js', 'Pods/Orders/Invoice.swift', 'web/app.min.js'
    ]) {
        assert.equal(categoryOf(file), 'generated_churn', file);
    }
    assert.equal(categoryOf('tests/build/invoice_test.go'), 'leaf_test');
    assert.equal(categoryOf('src/generator/invoice.ts'), 'production');
    assert.equal(categoryOf('src/oxygen.ts'), 'production');
});

test('configuration inside test paths configures the test harness', () => {
    for (const file of ['src/test/resources/application.yml', 'tests/config/env.ts']) {
        assert.equal(categoryOf(file), 'shared_test_helper_or_harness', file);
    }
    assert.equal(categoryOf('cypress/tsconfig.json'), 'shared_test_helper_or_harness');
});

test('non-configuration files under src, bin and scripts stay production and unknown files elsewhere stay ambiguous', () => {
    for (const file of ['src/reports/ui/lang-packs/en.json', 'src/assets/logo.svg', 'bin/garda']) {
        assert.equal(categoryOf(file), 'production', file);
    }
    for (const file of ['assets/logo.svg']) {
        assert.equal(categoryOf(file), 'ambiguous', file);
    }
    assert.equal(categoryOf('Dockerfile'), 'production');
    assert.equal(categoryOf('docs/examples/invoice.ts'), 'global');
    assert.equal(categoryOf('tests/fixtures/workspace/package.json'), 'shared_test_helper_or_harness');
});

test('helper-named production folders stay production while test helpers keep their structural category', () => {
    for (const file of [
        'app/helpers/invoices_helper.rb', 'src/helpers/format.ts', 'lib/support/retry.ex', 'src/setup.ts',
        'app/helpers/special_offers_helper.rb', 'app/helpers/latest_posts_helper.rb', 'app/helpers/inspection_helper.rb',
        'engines/shop/app/helpers/format_helper.rb', 'packages/ui/src/support/format.ts',
        'orders/helpers/format.py', 'orders/helpers/money.py', 'orders/support/retry.ex'
    ]) {
        assert.equal(categoryOf(file), 'production', file);
    }
    for (const file of ['bin/setup', 'app/views/support/new.html.erb', 'orders/support/template.txt']) {
        assert.notEqual(categoryOf(file), 'shared_test_helper_or_harness', file);
    }
    for (const file of [
        'tests/helpers/render.ts', 'src/__mocks__/fs.js', 'src/setupTests.ts',
        'fixtures/seed.ts', 'fixtures/invoice.json', 'features/support/env.rb',
        'jest.setup.js', 'src/jest.setup.ts', 'vitest.setup.ts', 'features/step_definitions/invoice_steps.rb'
    ]) {
        assert.equal(categoryOf(file), 'shared_test_helper_or_harness', file);
    }
});

test('integration and e2e folder names below source roots do not turn production helpers into tests', () => {
    for (const file of [
        'src/integration/setup/stripe.ts', 'src/main/java/com/acme/integration/support/MessageRouter.java',
        'app/integration/helpers/slack.rb', 'src/acceptance/support/approval.ts',
        'src/qa/helpers/inspector.ts', 'src/e2e/setup/client.ts', 'src/helpers/qa_adapter.ts',
        'app/support/integration.rb', 'src/setup/e2e.ts'
    ]) {
        assert.equal(categoryOf(file), 'production', file);
        assert.equal(categoryOf(file, 'added'), 'production', file);
    }
    for (const file of ['tests/integration/setup/stripe.ts', 'src/test/e2e/setup/client.ts',
        'src/integration/setup/stripe.test.ts', 'e2e/setup/client.ts']) {
        assert.equal(categoryOf(file), 'shared_test_helper_or_harness', file);
    }
    assert.equal(categoryOf('src/integration/vendor/client.ts'), 'generated_churn');
    assert.equal(categoryOf('tests/integration/vendor/client.ts'), 'leaf_test');
    const filePath = 'src/e2e/setup/client.ts';
    assert.equal(reviewRemediationDeltaInternals.categorizeFile({
        filePath, operation: 'modified', changedLines: 10, lineDeltaUnavailableReason: null,
        baselineStatus: 'text', currentStatus: 'text',
        testPathRegexes: [...DEFAULT_REVIEW_TRIGGER_POLICY.test_path_regexes, '^src/e2e/'], structuralPatterns,
        structuralThreshold: DEFAULT_REVIEW_TRIGGER_POLICY.test_refactor_changed_lines_threshold
    }).category, 'shared_test_helper_or_harness');
});

test('third-party code and build output stay generated even when a path inside them looks like a test', () => {
    for (const file of [
        'vendor/github.com/acme/orders/invoice_test.go', 'node_modules/acme/__tests__/parser.test.ts',
        'vendor/acme/lib/tests/FooTest.php', 'Pods/Foo/Tests/x.swift', 'build/tests/a.js', 'third_party/foo/bar.go',
        'packages/ui/build/index.js', 'packages/ui/dist/index.js', 'coverage/lcov.info', 'src/invoice_generated.ts',
        'internal/mocks/wire_gen.go'
    ]) {
        assert.equal(categoryOf(file), 'generated_churn', file);
    }
    for (const file of ['tests/fixtures/vendor/a.go', 'testdata/vendor/x.go']) {
        assert.equal(categoryOf(file), 'shared_test_helper_or_harness', file);
    }
    assert.equal(categoryOf('src/test/resources/target/x.json'), 'leaf_test');
});

test('folders named like build output are ordinary folders inside source folders', () => {
    for (const file of [
        'src/build/compiler.ts', 'packages/build/src/index.ts', 'crates/gen/src/lib.rs', 'scripts/build/release.ts',
        'internal/out/writer.go', 'src/main/java/orders/target/TargetService.java', 'src/coverage/calc.ts', 'src/id_gen.ts'
    ]) {
        assert.equal(categoryOf(file), 'production', file);
    }
    assert.equal(categoryOf('internal/build/build_test.go'), 'leaf_test');
    assert.equal(categoryOf('tests/test_id_gen.py'), 'leaf_test');
});

test('code under a source folder that serves documentation pages stays code, and tests inside a documentation site stay tests', () => {
    for (const file of ['apps/web/src/app/docs/page.tsx', 'app/controllers/docs/pages_controller.rb']) {
        assert.equal(categoryOf(file), 'production', file);
    }
    for (const file of [
        'docs/components/Search.test.tsx', 'docs/examples/foo.test.ts', 'packages/docs/components/Search.test.tsx',
        'template/tests/test_x.py'
    ]) {
        assert.equal(categoryOf(file), 'leaf_test', file);
    }
    assert.equal(categoryOf('.github/scripts/test_release.py'), 'leaf_test');
});

test('documents below a docs folder stay documentation whatever their own path says about tests', () => {
    for (const file of [
        'src/docs/test/strategy.md', 'services/foo/docs/e2e/setup.md', 'src/docs/jest.setup.md', 'docs/tests/x.md'
    ]) {
        assert.equal(categoryOf(file), 'global', file);
    }
    assert.equal(categoryOf('tests/docs/guide.md'), 'leaf_test');
});

test('the folder decides whether configuration belongs to the application or to tests', () => {
    for (const file of [
        'config/test-setup.yml', 'config/mock-server.yml', 'myproject/settings_prod.py', 'myproject/local_settings.py',
        'project/settings/base/common.py', 'buildSrc/src/main/kotlin/java-conventions.gradle.kts'
    ]) {
        assert.equal(categoryOf(file), 'global', file);
    }
    for (const file of ['tests/config/app.yml', 'tests/config/settings.py', 'tests/config/env.ts', '__mocks__/config.json']) {
        assert.equal(categoryOf(file), 'shared_test_helper_or_harness', file);
    }
    for (const file of ['src/test/java/com/acme/config/InvoiceTest.java', 'tests/config/test_parser.py']) {
        assert.equal(categoryOf(file), 'leaf_test', file);
    }
});

test('source code in a config package below a source root is production code on every stack', () => {
    for (const file of [
        'src/config/limits.ts', 'src/app/config/database.ts', 'src/main/java/com/acme/config/SecurityConfig.java',
        'src/main/kotlin/com/acme/configs/Beans.kt', 'internal/config/loader.go', 'lib/acme/config/parser.ex',
        'app/services/config/reader.rb', 'packages/billing/src/config/rates.ts'
    ]) {
        assert.equal(categoryOf(file), 'production', file);
        assert.equal(categoryOf(file, 'added'), 'production', file);
    }
});

test('ambiguous suite names do not turn source config packages into test configuration', () => {
    for (const folder of ['integration', 'acceptance', 'qa', 'e2e']) {
        const file = `src/main/java/com/acme/${folder}/config/RestConfig.java`;
        assert.equal(categoryOf(file), 'production', file);
        assert.equal(categoryOf(file, 'added'), 'production', file);
        assert.equal(categoryOf(`src/test/java/com/acme/${folder}/config/RestConfigTest.java`), 'leaf_test', folder);
    }
    assert.equal(categoryOf('src/integration/config/application.yml'), 'global');
    assert.equal(categoryOf('tests/integration/config/env.ts'), 'shared_test_helper_or_harness');
});

test('a config folder at the repository or package root stays configuration whatever the file type', () => {
    for (const file of [
        'config/routes.rb', 'config/application.rb', 'config/initializers/stripe.rb', 'config/environments/production.rb',
        'config/app.php', 'config/config.exs', 'config/runtime.exs', 'packages/web/config/webpack.js',
        'config/src/loader.ts', 'config/lib/settings_loader.rb'
    ]) {
        assert.equal(categoryOf(file), 'global', file);
        assert.equal(categoryOf(file, 'added'), 'global', file);
    }
});

test('configuration files stay configuration also in a config package below a source root', () => {
    for (const file of [
        'src/config/app.yml', 'src/main/resources/config/application.properties', 'src/config/settings.json',
        'src/config/vite.config.ts', 'config/settings.py'
    ]) {
        assert.equal(categoryOf(file), 'global', file);
    }
    // Owned configuration (`.env`, `database.yml`) is classified before the folder is looked at, here as at the root.
    for (const file of ['src/config/.env', 'src/config/database.yml']) {
        assert.equal(categoryOf(file), categoryOf(file.replace(/^src\//u, '')), file);
        assert.equal(categoryOf(file), 'production', file);
    }
});

test('test files in a config package below a source root keep their test category', () => {
    assert.equal(categoryOf('src/config/limits.test.ts'), 'leaf_test');
    assert.equal(categoryOf('src/config/limits.test.ts', 'added'), 'leaf_test');
    assert.equal(categoryOf('src/test/java/com/acme/config/SecurityConfigTest.java'), 'leaf_test');
    assert.equal(categoryOf('src/config/__mocks__/loader.ts'), 'shared_test_helper_or_harness');
});

test('test data manifests stay test data while real test packages keep their manifests', () => {
    for (const file of ['src/test/resources/projects/basic/pom.xml', 'tests/data/package.json']) {
        assert.equal(categoryOf(file), 'leaf_test', file);
    }
    assert.equal(categoryOf('tests/package.json'), 'production');
});

test('shared test support of every stack keeps its structural category wherever it lives', () => {
    for (const file of [
        'internal/testutil/server.go', 'internal/testhelper/db.go', 'src/testhelpers/db.ts', 'src/test-utils.tsx',
        'packages/test-utils/src/render.tsx', 'qa/src/helpers/login.ts', 'integration/lib/support/driver.rb',
        'crates/api/tests/common.rs', 'tests/common/mod.rs', 'tests/utils/render.tsx', 'tests/utils.py',
        'src/test/java/com/acme/TestUtils.java', 'src/test/java/com/acme/AbstractIntegrationTest.java',
        'tests/TestBase.cs', 'tests/TestCase.php', 'tests/bootstrap.php', 'tests/Pest.php',
        'features/steps/login_steps.py', 'features/environment.py', 'features/step-definitions/login.steps.ts'
    ]) {
        assert.equal(categoryOf(file), 'shared_test_helper_or_harness', file);
    }
    assert.equal(categoryOf('public/bootstrap.php'), 'production');
    assert.equal(categoryOf('src/jest.setup.md'), 'global');
    assert.equal(categoryOf('src/invoice.test.ts'), 'leaf_test');
});

test('shared test helper patterns a project adds itself apply to source files under source roots too', () => {
    const custom = reviewRemediationDeltaInternals.compilePatterns(
        [...DEFAULT_REVIEW_TRIGGER_POLICY.test_refactor_structural_path_regexes, '(^|/)src/qa/',
            '(^|/)lib/features/testkit/', '(^|/)src/features/support/'], 'structural test path regexes'
    );
    const categoryWith = (filePath: string): string => reviewRemediationDeltaInternals.categorizeFile({
        filePath,
        operation: 'modified',
        changedLines: 10,
        lineDeltaUnavailableReason: null,
        baselineStatus: 'text',
        currentStatus: 'text',
        testPathRegexes: DEFAULT_REVIEW_TRIGGER_POLICY.test_path_regexes,
        structuralPatterns: custom,
        structuralThreshold: DEFAULT_REVIEW_TRIGGER_POLICY.test_refactor_changed_lines_threshold
    }).category;
    assert.equal(categoryWith('src/qa/driver.ts'), 'shared_test_helper_or_harness');
    assert.equal(categoryWith('lib/features/testkit/presentation/test_kit.dart'), 'shared_test_helper_or_harness');
    assert.equal(categoryWith('src/features/support/TestService.ts'), 'shared_test_helper_or_harness');
    assert.equal(categoryWith('src/helpers/format.ts'), 'production');
});

test('project instructions are ordinary production files', () => {
    for (const file of ['AGENTS.md', 'CLAUDE.md', 'docs/agent-rules/reviews.md']) {
        assert.equal(categoryOf(file), 'production', file);
    }
});
