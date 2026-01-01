# P5: step-timing для эталонного стенда

Спецификация для исполнителя `universal-stand`; реализация после слияния universal-base.
Основание: concept §7.4–7.5. Сейчас timing-стенд не запускался; эта машина занята другими исполнителями.

## Измеряемая граница

- Отдельный явный режим `--step-timing`, `JOBS=1`. Он использует настоящие `resolveNextStep` и проверенные route checkpoints стенда. Никаких запусков тестов/build/review внутри измеряемого интервала.
- Wall time: `process.hrtime.bigint()` непосредственно перед вызовом и сразу после возврата/исключения. Включить проверку invocation dependencies, закрытие snapshot/barrier и выбор результата. Setup fixture, восстановление checkpoint, сравнение результата, сериализация, запись отчёта и вывод находятся вне интервала.
- Основной ряд — прогретый процесс: импорт runtime и 5 прогревочных вызовов вне выборки, затем 100 последовательных вызовов на маршрут. Каждый вызов получает новую read observation; cache между вызовами специально не прогревается подменой API. Реальные штатные caches остаются включёнными. Route, команды, статус и semantic input identity обязаны совпасть на всех 100 вызовах.
- Checkpoint read-only: scope, entry, цикл, lanes, selection/execution, artifacts и настройки неизменны. После вызова проверить отсутствие неожиданных мутаций; допустимые штатные advisory writes объявляются в checkpoint manifest. Для мутации/effect — отдельный checkpoint до/после с новой observation. Восстановление входов всегда вне таймера.
- Холодный CLI/startup — отдельный необязательный ряд `cli-cold` в новых процессах; он не смешивается с `resolver-warm`. Compile cache, Defender и файловый cache не отключать ради улучшения цифр; режим и состояние записывать.
- `GARDA_NEXT_STEP_TIMING` и подробные work wrappers в timing-ряду выключены: они сами обходят metadata и добавляют время. Counters снять отдельным проходом на тех же checkpoints. Фазовые диагностические времена показывать отдельно, не складывать inclusive phases и не подменять ими end-to-end wall time.

## Условия и воспроизводимость

Оператор резервирует свободную машину, остальные исполнители/CI/build/индексация не работают. Перед рядом — 30 секунд idle-проверки (средний host CPU <10%, нет тяжёлых процессов); фиксировать power plan, CPU, RAM, диск, OS build, Node exact version/arch, runtime/package digest, commit, Defender/coverage state. Host CPU снимать и во время ряда вне timed calls. При конкурирующей тяжёлой работе или изменении режима питания весь затронутый ряд `INCONCLUSIVE`, без удаления отдельных «медленных» samples. Не превращать шум в PASS повторением до удобного результата.

Baseline и candidate сравнивать на той же машине, OS/Node и режиме. По возможности предыдущий release повторить непосредственно перед candidate; сохранить и сравнение с сохранённым release baseline, и парное сравнение. Дрейф контрольного release за допустимые пределы делает сравнение inconclusive. Неподходящая среда, изменённая fixture или отсутствующий baseline не дают PASS.

Checkpoint manifest охватывает startup, selection, каждый invocation polyglot plan, execution pending/failed/passed, expected RED/GREEN, quality binding/repair/cadence, focused, preserved review, active/review check, recovery, completion, DONE/drift и parent audit. Фиксировать coverage route→scenario; новый route без checkpoint даёт `UNBASELINED`. Одинаковые короткая/длинная истории имеют одинаковые scope/команды/lanes; обе входят отдельными рядами. Их work delta проверяется независимо от timing.

## Хранение и сравнение

Версионированный JSON baseline предыдущего принятого release; raw samples и отчёт текущего запуска — в run artifacts. Пример сокращённой записи:

```json
{
  "schema_version": 1,
  "release": "1.4.4",
  "source_commit": "<full-sha>",
  "package_sha256": "<sha256>",
  "harness_sha256": "<sha256>",
  "checkpoint_manifest_sha256": "<sha256>",
  "environment": { "machine_id": "perf-win-01", "os": "<exact-build>", "node": "<exact-version>", "arch": "x64", "quiet": true },
  "protocol": { "mode": "resolver-warm", "warmups": 5, "samples": 100, "quantile": "nearest-rank", "jobs": 1 },
  "routes": [{
    "key": "unknown/a1/generic/task-tests-pending/history-2",
    "next_gate": "<observed-gate>",
    "semantic_inputs_sha256": "<sha256>",
    "raw_inputs_manifest_sha256": "<sha256>",
    "samples_ms": [120.1, 119.8],
    "median_ms": 119.95,
    "p95_ms": 120.1,
    "limits": { "median_relative": 0.10, "median_absolute_ms": 20, "p95_relative": 0.15, "p95_absolute_ms": 50 },
    "budget_reason": "<required current inputs and owning counter checks>"
  }],
  "baseline_update": { "reason": "<written decision>", "previous_sha256": "<sha256-or-null>" }
}
```

В настоящей записи требуется ровно 100 samples. Сохранить хеши и raw manifests обоих releases. Semantic identity нормализует только явно объявленные fixture-root, timestamps, случайные IDs и runtime bindings; target bytes, команды, роли, размеры истории, число lanes и настроек сохраняются. Изменение нормализации требует письменного решения; новый fixture manifest нельзя автоматически приравнять к старому.

Median: среднее двух центральных samples после сортировки; p95: sorted[`ceil(0.95*N)-1`]. Для каждого показателя показать `candidate−baseline` в ms и процентах (при baseline=0 процент — null). Предлагаемые стартовые допуски: median 10%/20 ms, p95 15%/50 ms. FAIL, если хотя бы один рост больше `max(absolute_limit, relative_limit*baseline)`. Допуски утверждаются в manifest **до** candidate run; менять baseline/допуск для устранения красного результата запрещено. Work budgets первичны: нарушение даёт FAIL даже при быстром wall time; subprocess ceilings не повышаются.

## Отчёт и прерывание

После каждого route атомарно сохранять samples, identities, counters, verdict, прогресс/ETA; resume разрешён только при совпадении source/package, среды, checkpoint и protocol hashes. Прерванный timing-ряд начать заново после новой idle-проверки, завершённые ряды сохранить.

В едином отчёте стенда раздел Speed содержит две независимые оценки `work budgets` и `step timing`. Таблица: stack/scenario/route/history, N, baseline/candidate median и p95, Δms/Δ%, лимиты, verdict, ссылки на raw samples и растущие counters. Отдельно перечислить missing routes, invalid/quiet failures, baseline mismatches и обязательную canonical-byte работу. Общий Speed PASS возможен только при PASS обоих разделов и полной manifest coverage. Принятие нового baseline — отдельное осознанное действие с причиной и exact release identity.
