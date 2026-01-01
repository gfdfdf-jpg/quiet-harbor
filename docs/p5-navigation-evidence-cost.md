# P5: navigation и evidence — фаза 1

База: `aafb5119567e90507eb2879f14be6c1d4e4d7c89` (Garda 1.4.4), detached HEAD.
Worktree: `D:\Projects\Garda Studio Projects\_worktrees\garda-agent-orchestrator\p-performance`.
Артефакты: `C:\Users\dshub\AppData\Local\Temp\garda-sol-performance`.
Продуктовый код не изменён; selection/execution/next-step передаются их владельцам только как план.

## Статус требований

| Требование | Уже есть в aafb5119 | Подтверждённый остаток |
|---|---|---|
| T-451-2-3 | Ленивые основные report-проекции; общие immutable timeline records; терминальная authenticated projection с source drift detection | `compile-gate` загружает/клонирует каталог review artifacts; DONE/drift всё ещё обходят каталог. Прямые проверки текущих именованных artifacts остаются необходимыми, это не обход истории |
| T-451-3 | Реальный Q1 включён в default test и release coverage; одно canonical verification/parse; отдельные artifact budgets | Не все derivations имеют current selectors. Исторические INFO-события добавляют обходы, копии и JSON.parse. Строгий zero-growth всех counters красный даже без лишних consumers: canonical capture/parse/integrity всё ещё O(history) |
| T-415-1, только стабильная read-фаза | Один factory request и immutable snapshot внутри observation; новая фаза видит изменённые bytes. Git/hash/bytes не повторяются для повторного request.read | Сам ключ `request.read` снова разрешает cache path через `joinOrchestratorPath`: 3 existsSync на target на повтор. В `buildReviewContext` task_scope отдельно вызывает `buildDomainScopeFingerprints` после `buildReviewTreeState`; это статически подтверждённый кандидат, отдельный gate budget ещё нужен |
| T-416, только counters | Эквивалентный Git read: initial + final, ACL root/file: bounded initial pair + независимые final checks. Мутации/замены/ACL changes отвергаются | На измеренных routes history не добавляет Git/ACL/probes/reads/hashes. Второй ACL-механизм не нужен. На универсальной базе ceilings нельзя повышать; cold timing/timeout policy здесь не квалифицировались |
| T-452, только доказанное нарушение route budget | В P5 не переносится весь parent/citation refactor | В измеренных routes такой остаток не установлен. `readParentOutput` по-прежнему читает Git blob на cited path, но без отдельного native parent/record-review budget это не основание включать исправление в P5 |

Не объявлять T-451/T-415/T-416/T-452 целиком DONE по этим частичным проверкам.

## Измерения на базе

Windows, Node `v24.22.1`; машина общая, поэтому wall times служат только диагностикой, не acceptance. До проверок удалены `GIT_CONFIG_*`, System32 поставлен первым в PATH; TMP/TEMP/TMPDIR направлены в P5 TMP. Никаких CI, установок, staging, commits или Garda task mode в этом checkout.

В startup fixtures добавлены только 126 аутентифицированных INFO-событий (2 → 128 notes), scope и artifacts неизменны. Native fixture: один завершённый review cycle, одна lane, 64 scope-файла; отдельно измерены active, required reviews, DONE и drift. Это targeted counter tests, не запуск режимов стенда. Колонки payload/hash — число операций, не объём bytes; index — сумма visit counters каталога, не число файлов.

| next-step route | Git | icacls | payload reads | file hashes | index visits |
|---|---:|---:|---:|---:|---:|
| enter-task-mode | 0 | 4 | 42 | 3 | 0 |
| classify-change | 4 | 7 | 54 | 12 | 0 |
| compile-gate | 16 | 7 | 67 | 18 | 16 |
| active-review → record-review-result | 18 | 13 | 856 | 805 | 0 |
| required-reviews-check | 18 | 13 | 862 | 803 | 8 current named-file visits; catalog 0 |
| DONE | 10 | 8 | 658 | 598 | 183 |
| post-done-drift | 10 | 8 | 657 | 596 | 183 |

Это исходные измеренные значения конкретных fixtures. Ceilings Git/ACL закреплены тестами; их превышение нельзя узаконить обновлением ожидания. На других OS native ACL проверяется только там, где доступен Windows; это не Linux/macOS acceptance. Большое число уникальных hashes включает runtime/code authority inputs: отсутствие повторного hash не означает, что все эти inputs можно безопасно убрать.

Подтверждённая лишняя работа по маршрутам:

| Route / вызов | Файл, функция | Наблюдение / необходимое изменение |
|---|---|---|
| enter-task-mode | `next-step-startup-routing.ts::readFailedTaskModePublicationRecoveryRoute` | 2→128 event visits, map/reverse/copy всего timeline при поиске отсутствующей TASK_MODE_ENTERED. Выбирать последние точные witnesses из verified index |
| enter-task-mode, classify-change | `task-audit-summary-review-timing-audit.ts::readReviewExecutionPolicyModeFromCurrentCycleTimeline` | 2→128 и 6→132 visits при отсутствии PREFLIGHT_CLASSIFIED. Нужен current preflight/policy fact, а не сканирование INFO tail |
| classify-change | `next-step-preflight-recovery.ts::getLatestTimelineSequence`, `next-step-timeline-readers.ts::findLatestTimelineEvent`, `task-route-query.ts::routePreflightWitnesses` | Дополнительные ordered witnesses/обходы при прежних semantic inputs. Хранить нужные sequence/prefix факты во время canonical pass, сохранять ordering и diagnostics |
| compile-gate | `next-step-review-cycle-guard-attempts.ts::readReviewCycleGuardAttempts` → `review-attempt-artifact-index.ts::createReviewAttemptArtifactIndexInternal` → `reviews-index.ts::loadTaskIndex` | Native trace подтвердил eager catalog: 5 candidates + 5 clones + 5 task-entry visits + 1 file. Создавать reader лениво после доказанной необходимости; current mode читает точные bound paths |
| compile-gate | `next-step.ts::resolveTimelineBoundReviewDependencyGraph` | 2→128 backward visits; +252 JSON.parse при +126 notes против +126 canonical parse. Выбирать preflight witness из проверенного index; отдельно устранить повторный raw JSON parse |
| current review evidence | `next-step-review-evidence.ts::readCompleteReviewTimelineEvidence` | 2/16 COMPILE_GATE_PASSED → 2/16 compile candidates. Events уже общие; достаточно canonical-pass max допустимого compile sequence |
| DONE/drift | `reviews-index.ts::readIndexFile`, `cloneReviewsIndex`, `createTaskScopedIndexView`; terminal consumers `next-step.ts` / `task-audit-summary.ts` | Проекция выбрана, но всё равно 34 name + 66 task-entry + 45 candidate + 36 clone + 2 file visits. На native projection route убрать acquisition каталога; сохранить authentication всех текущих closeout/ledger/source inputs |
| workspace read phase | `workspace-snapshot-cache.ts::normalizeExplicitRequestFiles` → `isInternalSnapshotCachePath` → `resolveSnapshotCacheRepoRelativePath` | 8 одинаковых read → 24 existsSync. Разрешить cache-root один раз при factory capture; строить последующие keys чисто из сохранённых scalar inputs |

Raw measurements сохраняют **все** counters, включая timeline bytes/events, index construction, deep-freeze/memo objects, parsing и copies. Для сравнения нормализуются только PID/time/UUID в lock filenames и process bucket identity; количество операций сохраняется. Ни growing allowlist, ни нормализации timeline bytes нет. Stable-input control отделяет history growth от первого acquisition/advisory effects.

## Новые регрессии

- `next-step-p5-route-cost.test.ts`: реальные startup/classify/compile routes, полное равенство результата, stable-input controls, ceilings Git/ACL, отсутствие report/clones/повторных hashes; отдельные RED assertions для catalog acquisition и strict history growth.
- `next-step-p5-evidence-cost.test.ts`: настоящий verified timeline и current compile witness при 2/16 compiles; RED — 2/16 candidates. Canonical verify/read остаются по одному, mutable event copies отсутствуют.
- `workspace-p5-read-phase.test.ts`: один request в фазе, отсутствие новых процессов/reads/hashes, новая generation после mutation и другой scope hash; RED — 24 existsSync на 8 повторов в каждой фазе.
- `next-step-p5-authenticated-cost.test.ts`: native producers → active review → required review → completion → DONE → source drift; projection/authentication проверяются. RED — terminal catalog и strict growth; текущая named membership не запрещается.
- `p5-budget-selection.test.ts`: actual `resolveSelectedTestFiles` для новых regressions через default и release coverage, с negative control удаления gates. Никакие полные группы не выполняются.
- `next-step-p5-cost-fixture.ts`: общий raw counter collector; атомарные отдельные report files для test processes, чтобы один не перетирал другой.

Проверки:

- Исходные startup/measurement/invocation/ACL/Git/file/snapshot/selection: **95/95 PASS**, `baseline-targeted.log`.
- Дополнительные исходные long-history measurement, task-mode observation и walk-economy units: **59/59 PASS**, 18,2 s, `measurement-economy.log`.
- Новые P5: **15 зелёных / 9 красных assertions**, плюс 5 красных parent nodes (Node summary: 29 tests, 15 pass, 14 fail), 126,3 s, `p5-acceptance-tests.log`. Все красные результаты — описанные budgets; ошибок setup в итоговом прогоне нет. Collection guard и stable-input controls зелёные. Native active/current checks зелёные; terminal catalog красный.
- `synthetic-policy-reuse`: первый case с тремя checkpoint walks PASS (513,9 s, по одному code/test FULL); дальнейший общий прогон остановлен до 15 минут. Остальные cases файла **не квалифицированы**, весь файл зелёным не объявляется (`review-economy.log`).
- Обе tsc-конфигурации с `--noEmit --noUnusedLocals --noUnusedParameters` и eslint новых TS зелёные. Diff/patch checks — в TMP progress.

Красные budget assertions оставлены обычными assertions, без skip/TODO/xfail. Новые TS-файлы для узких повторов транспилированы локально поверх исходной `.node-build`; полная проверка типов выполнена отдельно обоими tsconfig. Окончательные raw samples: `p5-acceptance-counters.next-step-p5-route-cost.json` и `p5-acceptance-counters.next-step-p5-authenticated-cost.json`; промежуточные логи не являются итоговой приёмкой.

## План фазы 2 на merged base

Порядок: сначала переснять counters на выданном merged SHA, затем исправить только сохранившиеся нарушения. Ownership сверено с briefs core/fallbacks/stand; здесь ни один из их product/synthetic files не меняется.

1. **Core, navigation/review guard:** `next-step.ts::resolveTimelineBoundReviewDependencyGraph`, `next-step-startup-routing.ts::readFailedTaskModePublicationRecoveryRoute`, `task-audit-summary-review-timing-audit.ts::readReviewExecutionPolicyModeFromCurrentCycleTimeline`, `next-step-preflight-recovery.ts::{getLatestTimelineSequence,isOriginalEntryImplementationRefresh}`, `task-verified-event-index.ts::beginVerifiedEventIndexPass`. Добавить current facts в существующий canonical pass и exact selectors; сохранить legacy coercion, nonmonotonic timestamps, order/tie/error semantics, task entry, pending refresh, completion и A/B/A lineage. Тесты: новые P5 + owning startup/recovery/route-query/index suites.
2. **Core, catalog lifetime:** `next-step-review-cycle-guard-attempts.ts::readReviewCycleGuardAttempts`, `review-attempt-artifact-index.ts::{createReviewAttemptArtifactIndexInternal,createCurrentReviewAttemptArtifactIndex}`, terminal branches в `next-step.ts`/`task-audit-summary.ts`. Reader ленивый, active/terminal reads — точные current bindings. Сохранить mutable public index API, transaction barriers, missing/corrupt snapshots, current custom-lane membership и полный явный audit. Тесты: P5 catalog assertions + owning index/closed-history/corruption/terminal tests.
3. **P5 после передачи common workspace/context:** `workspace-snapshot-cache.ts::{createWorkspaceSnapshotRequestUncached,normalizeSnapshotRequestKey,normalizeExplicitRequestFiles}`, `build-review-context.ts::buildReviewContext`, `review-tree-state.ts::buildReviewTreeState`. Один request/cache-root и общая projection только при полном совпадении detection source/includeUntracked/scope/classification policy. Проверить равенство `task_scope` и tree fingerprints; разные views не объединять. Тесты: P5 phase/no-probe, owning workspace cache и build-review-context counters, итоговая mutation/freshness проверка.
4. **Fallbacks + core, remaining evidence readers:** `native-case-semantics.ts::readNativeCaseObligations`, `focused-intermediate-evidence.ts`, quality readiness/timeline readers. Заменить raw split/JSON.parse и historical candidate acquisition verified current views; late completion сохраняет pre-epoch start, duplicate execution ID остаётся неоднозначным. Memo только внутри read-фазы, identity включает task/entry/epoch/preflight/selection/execution и inspection mode. Тесты: native expected RED/GREEN, two targets, delayed starts, stale/tamper, quality binding/repair/cadence, preserved FULL/DELTA. На base эти branches полностью не квалифицированы; после R1–R4 нужны реальные reached routes.
5. **Mutation boundaries:** selection/execution/compile/recovery owners захватывают before/after observations и публикуют checked bindings. Навигация только сравнивает сохранённые bindings; никаких новых Git/ACL/probes на invocation. Любой build/test/external effect закрывает read-фазу, после него новый snapshot и currentness check. Не растягивать memo через `executeNextStepEffects` и native filters; существующий regression clean/smudge сохраняется.
6. **Stand owner, regression contract:** встроить новые assertions в route manifest, добавить реальные 2/16 closed cycles для новых universal/preserved-claims/expected-RED/quality/recovery/parent routes; сохранить current input sizes и mandatory-byte counters. P5 одноцикловой fixture не подменяет эту квалификацию. Интегрировать [timing spec](p5-step-timing-spec.md). Проверить default/release inclusion через actual collection, не запуском полной группы.
7. **Отдельное архитектурное решение, blocker буквального zero-growth:** `task-timeline-read-snapshot.ts` / `task-events-integrity.ts` сейчас каждый вызов проверяют полный mutable timeline. Без независимого trusted append-only authority безопасная O(1) история невозможна: stat/mtime или подписанный собственными claims sidecar не доказывает неизменность prefix. Сохранить RED и явно вынести решение координатору; canonical integrity не ослаблять, O(N) не прятать в allowlist. Известный P6 deferred дизайн описан в `next-step-performance-deferred.md`.

Выбор решений feature/2.0:

| Commit | Что брать выборочно / что уже есть |
|---|---|
| `cfcad18b` | Общие immutable verified events уже есть. Взять current max compile/witness и execution epoch/range selectors там, где их ещё нет; raw native-case parsing убрать с учётом более поздних carry semantics |
| `1913c070` | Current preflight/recovery sequence и original-entry facts. Не переносить старый recovery код поверх новых R-gates |
| `1c195337` | Binding/repair witness под теми же byte/event/tail bounds. Signed cadence fast path уже есть; второй cadence механизм не нужен, unsigned legacy reports остаются authenticated inputs |
| `95ed1112` | Scalar immutable memo identities и bounded preserved-claim acquisition. Его `test-only-review-preservation.ts` на базе отсутствует: адаптировать решение к `review-remediation-origin.ts::{iterateRemediationOriginCandidates}` / `review-remediation-scope-review-types.ts::collectRemediationLaneHistory`, не создавать параллельную старую authority. Добавить pending recovery types в route-query только после проверки новых producer/order semantics |

Риски: universal-base изменит interfaces и набор обязательных inputs; старые performance patches могут отменить поздние carry/order/recovery проверки. Не убирать security/currentness probes только ради числа. Терминальный fallback без projection/ledger и unsigned legacy cadence должны оставаться честным native fallback. Timing baseline на занятой машине не создаётся. Full authenticated Q1 2/16, неизвестный стек/polyglot и native acceptance других OS остаются интеграционной работой владельцев после слияния.

## Фаза 2: реализация на universal base

База `49924597efd7bc204bb228171c3f1c2c7b143158`, тот же detached worktree. Решение оператора заменяет пункт 7 плана: история допускает линейную стоимость, без ослабления canonical integrity. На вызов остаются ровно один verification pass и один parse каждого события; число visits canonical index равно числу событий. Bytes учитываются полностью. Допуск обхода memo-графа вычисляется из фактических объектов/полей добавленных JSON records и фиксированных JSONL/verification wrappers. Отдельный per-file chunk counter доказывает один forward stream content observation: `ceil(bytes / 65536) + 1` с EOF-read. Только пересечение этих границ у timeline объясняет рост общего `readSync`. У consumer walks, clones, artifact acquisition, subprocesses, probes, hashes и остального non-history work допуск положительного роста равен нулю. Negative controls проверяют, что лишняя работа не попадает в этот допуск.

Реализация:

- Verified index сохраняет текущий compile maximum; review evidence больше не приобретает все старые compile candidates. Preflight policy/dependency, skipped reviews, recovery и task-mode readers выбирают нужные типы из общей проверенной истории. Порядок и legacy fallback сохраняются.
- Guard приобретает exact artifact reader только при первом snapshot-запросе. В navigation он использует immutable canonical records вместо повторного чтения/JSON.parse всего timeline. Публичные mutable readers не меняются; внутреннее recovery view memoized только до конца read observation.
- Terminal commit presentation читает существующую настройку `EnforceNoAutoCommit` через общий resolver с прежним live/answers приоритетом. Полный workspace status с provider-compliance catalog scan остаётся у явного audit/status; terminal presentation больше не запускает его ради одного boolean.
- Workspace request фиксирует cache-relative path в своей generation, поэтому повторные эквивалентные keys не делают file probes. Разные detection source/includeUntracked/scope views остаются разными. Изменения в сборке tree/task_scope projections не потребовались для девяти проверяемых budgets и остаются в области общего workspace/context владельца.
- Native-case projection использует canonical records подходящих типов; quality cadence fallback выбирает только checklist/review events. Generic validation contract `src/core/task-validation-plan.ts` и правила carry/start/selection не заменяются.

Authenticated history fixture добавляет notes через native append API в bundle root, сохраняя signed cadence head. Прямое дописывание JSONL меняет ещё и currentness этой authority; оно остаётся отдельным recovery/legacy случаем, а не равным history-only входом. Исходные raw counters фазы 1 и первого universal замера сохранены отдельно.

Реализация стенда и step timing в P5 не входят: [спецификация для reference-stand executor](p5-step-timing-spec.md). Native closed-cycle 2/16 stand coverage, полная матрица и сравнение wall time на свободной машине остаются у его исполнителя. Точный before/after и результаты адресных проверок — в `P5-phase2.report.md` и raw JSON в P5 TMP.
