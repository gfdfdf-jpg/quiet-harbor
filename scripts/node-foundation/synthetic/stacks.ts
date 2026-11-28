import type { FileRole } from './model';

/**
 * Conventional project layouts per technology stack. Each role lists the paths a
 * typical project of that stack uses; the stand expects Garda to treat the same
 * role the same way on every stack. The project domain is "orders" on purpose:
 * words such as billing or payment are security triggers by design.
 */
export interface StackAdapter {
    id: string;
    paths: Readonly<Record<FileRole, readonly string[]>>;
    /** Conventions of the stack that a path cannot express; reported, never faked. */
    unexpressible: ReadonlyArray<{ role: FileRole; convention: string; reason: string }>;
}

const SHARED = {
    INFRA: ['Dockerfile', '.github/workflows/ci.yml'],
    DOCS: ['docs/orders.md', 'docs/setup.md', 'docs/test-setup.md', 'src/README.md', 'src/docs/index.html', 'packages/ui/docs/example.ts', 'src/docs/jest.setup.md']
} as const;

export const STACK_ADAPTERS: readonly StackAdapter[] = Object.freeze([
    {
        id: 'python',
        paths: {
            PROD: ['orders/invoice.py', 'src/orders/invoice.py'],
            UNIT_TEST: ['tests/test_invoice.py', 'orders/invoice_test.py'],
            TEST_HELPER: ['tests/helpers/factories.py', 'conftest.py', 'tests/utils.py', 'features/steps/invoice_steps.py', 'features/environment.py'],
            TEST_FIXTURE: ['tests/fixtures/invoice.json'],
            CONFIG: ['config/settings.yaml', 'orders/settings.py', 'project/settings/production.py', 'project/settings_prod.py', 'project/local_settings.py'],
            DEP_MANIFEST: ['pyproject.toml', 'requirements.txt', 'setup.py'],
            API: ['orders/routes/invoices.py'],
            DB_MIGRATION: ['migrations/0001_initial.sql'],
            AUTH: ['orders/auth/session.py'],
            GENERATED: ['orders/gen/invoice_pb2.py', 'third_party/orders/invoice.py'],
            ...SHARED
        },
        unexpressible: []
    },
    {
        id: 'go',
        paths: {
            PROD: ['internal/invoice/invoice.go', 'cmd/orders/main.go', 'internal/build/version.go'],
            UNIT_TEST: ['internal/invoice/invoice_test.go'],
            TEST_HELPER: ['internal/invoice/helpers_test.go', 'internal/testutil/server.go'],
            TEST_FIXTURE: ['internal/invoice/testdata/rounding.json'],
            CONFIG: ['config/orders.yaml'],
            DEP_MANIFEST: ['go.mod'],
            API: ['internal/api/invoice_handler.go'],
            DB_MIGRATION: ['migrations/0001_init.sql'],
            AUTH: ['internal/auth/session.go'],
            GENERATED: ['internal/gen/invoice.pb.go', 'vendor/github.com/acme/orders/invoice.go', 'internal/invoice/wire_gen.go'],
            ...SHARED
        },
        unexpressible: []
    },
    {
        id: 'rust',
        paths: {
            PROD: ['src/lib.rs', 'crates/orders/src/invoice.rs', 'crates/gen/src/lib.rs'],
            UNIT_TEST: ['tests/total.rs'],
            TEST_HELPER: ['tests/common/mod.rs', 'crates/orders/tests/common.rs'],
            TEST_FIXTURE: ['tests/fixtures/invoice.json'],
            CONFIG: ['config/default.toml'],
            DEP_MANIFEST: ['Cargo.toml'],
            API: ['src/routes/invoices.rs'],
            DB_MIGRATION: ['migrations/2024-01-01-000000_init/up.sql'],
            AUTH: ['src/auth/session.rs'],
            GENERATED: ['target/debug/build/orders/out/invoice.rs'],
            ...SHARED
        },
        unexpressible: [{
            role: 'UNIT_TEST',
            convention: '#[cfg(test)] mod tests inside a production file',
            reason: 'the test lives in the production file, so its path cannot mark it as a test'
        }]
    },
    {
        id: 'ruby',
        paths: {
            PROD: ['lib/orders/invoice.rb', 'app/models/invoice.rb', 'app/helpers/invoices_helper.rb', 'app/helpers/special_offers_helper.rb', 'engines/shop/app/helpers/format_helper.rb'],
            UNIT_TEST: ['spec/orders/invoice_spec.rb'],
            TEST_HELPER: [
                'spec/support/money_helpers.rb', 'spec/spec_helper.rb', 'spec/rails_helper.rb',
                'spec/shared_examples/payable.rb', 'features/support/env.rb', 'features/step_definitions/invoice_steps.rb'
            ],
            TEST_FIXTURE: ['spec/fixtures/invoices.yml'],
            CONFIG: ['config/orders.yml', 'config/setup.yml', 'apps/shop/config/environments/production.rb'],
            DEP_MANIFEST: ['Gemfile'],
            API: ['app/controllers/invoices_controller.rb'],
            DB_MIGRATION: ['db/migrate/20240101000000_create_invoices.rb'],
            AUTH: ['app/auth/session.rb'],
            GENERATED: ['vendor/bundle/ruby/orders/invoice.rb'],
            ...SHARED
        },
        unexpressible: []
    },
    {
        id: 'dotnet',
        paths: {
            PROD: ['src/Orders/Invoice.cs'],
            UNIT_TEST: ['tests/Orders.Tests/InvoiceTests.cs'],
            TEST_HELPER: ['tests/Orders.Tests/Helpers/InvoiceBuilder.cs', 'tests/Orders.Tests/TestBase.cs', 'Orders.Specs/Steps/InvoiceSteps.cs'],
            TEST_FIXTURE: ['tests/Orders.Tests/Fixtures/invoice.json'],
            CONFIG: ['src/Orders/appsettings.json', 'src/Orders/web.config'],
            DEP_MANIFEST: ['src/Orders/Orders.csproj'],
            API: ['src/Orders/Controllers/InvoicesController.cs'],
            DB_MIGRATION: ['src/Orders/Migrations/20240101000000_Init.cs'],
            AUTH: ['src/Orders/Auth/SessionService.cs'],
            GENERATED: ['src/Orders/obj/Debug/App.g.cs', 'src/Orders/Invoice.Designer.cs'],
            ...SHARED
        },
        unexpressible: []
    },
    {
        id: 'java-maven',
        paths: {
            PROD: ['src/main/java/orders/Invoice.java'],
            UNIT_TEST: ['src/test/java/orders/InvoiceTest.java', 'src/test/java/orders/config/InvoiceTest.java'],
            TEST_HELPER: ['src/test/java/orders/support/InvoiceFixtures.java', 'src/test/java/orders/TestUtils.java', 'src/test/java/orders/AbstractIntegrationTest.java'],
            TEST_FIXTURE: ['src/test/resources/fixtures/invoice.json'],
            CONFIG: ['src/main/resources/application.yml'],
            DEP_MANIFEST: ['pom.xml'],
            API: ['src/main/java/orders/web/InvoiceController.java'],
            DB_MIGRATION: ['src/main/resources/db/migration/V1__init.sql'],
            AUTH: ['src/main/java/orders/auth/SessionService.java'],
            GENERATED: ['target/generated-sources/orders/Invoice.java'],
            ...SHARED
        },
        unexpressible: []
    },
    {
        id: 'kotlin-gradle',
        paths: {
            PROD: ['src/main/kotlin/orders/Invoice.kt'],
            UNIT_TEST: ['src/test/kotlin/orders/InvoiceTest.kt'],
            TEST_HELPER: ['src/test/kotlin/orders/helpers/InvoiceBuilders.kt'],
            TEST_FIXTURE: ['src/test/resources/fixtures/invoice.json'],
            CONFIG: ['src/main/resources/application.conf', 'buildSrc/src/main/kotlin/java-conventions.gradle.kts'],
            DEP_MANIFEST: ['build.gradle.kts', 'settings.gradle.kts'],
            API: ['src/main/kotlin/orders/routes/InvoiceRoutes.kt'],
            DB_MIGRATION: ['src/main/resources/db/migration/V1__init.sql'],
            AUTH: ['src/main/kotlin/orders/auth/Session.kt'],
            GENERATED: ['build/generated/orders/Invoice.kt'],
            ...SHARED
        },
        unexpressible: []
    },
    {
        id: 'swift',
        paths: {
            PROD: ['Sources/Orders/Invoice.swift'],
            UNIT_TEST: ['Tests/OrdersTests/InvoiceTests.swift'],
            TEST_HELPER: ['Tests/OrdersTests/Helpers/InvoiceFactory.swift'],
            TEST_FIXTURE: ['Tests/OrdersTests/Fixtures/invoice.json'],
            CONFIG: ['config/orders.json'],
            DEP_MANIFEST: ['Package.swift'],
            API: ['Sources/Orders/Routes/InvoiceRoutes.swift'],
            DB_MIGRATION: ['Sources/Orders/Migrations/CreateInvoice.swift'],
            AUTH: ['Sources/Orders/Auth/Session.swift'],
            GENERATED: ['Pods/Orders/Invoice.swift'],
            ...SHARED
        },
        unexpressible: []
    },
    {
        id: 'elixir',
        paths: {
            PROD: ['lib/orders/invoice.ex'],
            UNIT_TEST: ['test/orders/invoice_test.exs'],
            TEST_HELPER: ['test/support/fixtures.ex'],
            TEST_FIXTURE: ['test/fixtures/invoice.json'],
            CONFIG: ['config/config.exs'],
            DEP_MANIFEST: ['mix.exs'],
            API: ['lib/orders_web/controllers/invoice_controller.ex'],
            DB_MIGRATION: ['priv/repo/migrations/20240101000000_create_invoices.exs'],
            AUTH: ['lib/orders/auth/session.ex'],
            GENERATED: ['_build/dev/lib/orders/invoice.ex'],
            ...SHARED
        },
        unexpressible: []
    },
    {
        id: 'cpp-cmake',
        paths: {
            PROD: ['src/invoice.cpp'],
            UNIT_TEST: ['test/invoice_test.cpp'],
            TEST_HELPER: ['test/helpers/invoice_builder.h'],
            TEST_FIXTURE: ['test/fixtures/invoice.json'],
            CONFIG: ['config/orders.json'],
            DEP_MANIFEST: ['CMakeLists.txt'],
            API: ['src/api/invoice_handler.cpp'],
            DB_MIGRATION: ['db/migrations/001_init.sql'],
            AUTH: ['src/auth/session.cpp'],
            GENERATED: ['build/gen/invoice.pb.cc'],
            ...SHARED
        },
        unexpressible: []
    },
    {
        id: 'nim',
        paths: {
            PROD: ['src/orders.nim'],
            UNIT_TEST: ['tests/test_total.nim'],
            TEST_HELPER: ['tests/helpers.nim'],
            TEST_FIXTURE: ['tests/fixtures/invoice.json'],
            CONFIG: ['config/orders.json'],
            DEP_MANIFEST: ['orders.nimble'],
            API: ['src/routes/invoices.nim'],
            DB_MIGRATION: ['migrations/001_init.sql'],
            AUTH: ['src/auth/session.nim'],
            GENERATED: ['src/generated/orders.nim'],
            ...SHARED
        },
        unexpressible: []
    },
    {
        id: 'node-ts',
        paths: {
            PROD: ['src/invoice.ts', 'src/helpers/format.ts', 'src/build/compiler.ts', 'packages/build/src/index.ts', 'apps/web/src/app/docs/page.tsx'],
            UNIT_TEST: ['src/invoice.test.ts', 'tests/invoice.test.ts', 'cypress/e2e/invoice.cy.ts', 'docs/components/Invoice.test.tsx'],
            TEST_HELPER: ['tests/helpers/render.ts', 'cypress/support/commands.ts', 'cypress/plugins/index.js', 'jest.setup.ts', 'src/test-utils.tsx', 'packages/test-utils/src/render.tsx', 'features/step-definitions/invoice.steps.ts'],
            TEST_FIXTURE: ['tests/fixtures/invoice.json'],
            CONFIG: ['config/default.json', 'vite.config.ts', 'karma.conf.js'],
            DEP_MANIFEST: ['package.json'],
            API: ['src/routes/invoices.ts'],
            DB_MIGRATION: ['migrations/001_init.sql'],
            AUTH: ['src/auth/session.ts'],
            GENERATED: ['src/generated/client.ts', 'node_modules/acme/index.js', 'packages/ui/build/index.js', 'src/invoice_generated.ts'],
            ...SHARED
        },
        unexpressible: []
    },
    {
        id: 'php',
        paths: {
            PROD: ['src/Orders/Invoice.php'],
            UNIT_TEST: ['tests/Orders/InvoiceTest.php'],
            TEST_HELPER: ['tests/Support/InvoiceFactory.php', 'tests/TestCase.php', 'tests/bootstrap.php'],
            TEST_FIXTURE: ['tests/Fixtures/invoice.json'],
            CONFIG: ['config/orders.php'],
            DEP_MANIFEST: ['composer.json'],
            API: ['src/Http/Controllers/InvoiceController.php'],
            DB_MIGRATION: ['database/migrations/2024_01_01_000000_create_invoices.php'],
            AUTH: ['src/Auth/SessionGuard.php'],
            GENERATED: ['vendor/acme/orders/Invoice.php'],
            ...SHARED
        },
        unexpressible: []
    }
]);
