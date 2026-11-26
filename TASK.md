# TASK · Autonomous mission: brechas → implementación

Checklist vivo. Marcar `[x]` solo cuando el código + tests + `npm run quality` lo confirmen.
Regla: respetar invariantes de `ARCHITECTURE.md` (`decide()` único, `finish` escribe terminal,
`serialize()` para escrituras, `.mission/` intocable, brief desde disco, re-plan monotónico,
hard caps absolutos, `this.d`, archivos <250 líneas, `npm run quality` verde).

## Fase 0 · Costo real y bases correctas

- [x] 0.1 Extraer `costFromContext()` a módulo puro (`src/mission/cost.js`) + exportar en `mission.js`/`deps.js`.
- [x] 0.2 Sumar costo de **todas** las sesiones de la misión (líder + workers + roles), con ledger durable en `agent_runs[].cost`.
- [x] 0.3 Contar costo de `options.generate` (planner, re-plan, split, distill) cuando el proveedor lo reporte.
- [x] 0.4 `cost_usd` monotónico: nunca retroceder al reconstruir desde contexto parcial.
- [x] 0.5 Verificar semántica de `failures` consecutivos: reset en idle exitoso (test añadido), sin diluir dentro de una racha.
- [x] 0.6 Alinear README/CONTRACT/RUNBOOK con defaults reales y con el modo relentless.
- [x] 0.7 Tests: costo multi-sesión, suma/merge, no regresión, `failures`.

## Fase 1 · Modo `relentless` (nunca rendirse, sin romper hard caps)

- [x] 1.1 Settings nuevos: `never_give_up`, `max_task_attempts`, `max_review_attempts`, `max_goal_audits=0` ilimitado.
- [x] 1.2 `decideNext`: `blocked` → re-plan forzado en vez de `stop` cuando `never_give_up`.
- [x] 1.3 `handleIdle`: soportar decisión `replan` y pasar `force` a `maybeReplan`.
- [x] 1.4 `review-high` → rework infinito (`maxReviewAttempts=0`) en vez de `stop`.
- [x] 1.5 `goal-gaps` → seguir iterando (reset contador / re-plan) en vez de `stop`.
- [x] 1.6 `repeated-execution-failure` → backoff + rotación + reset contador en vez de `abort`.
- [x] 1.7 `supervisor error` → recuperación (no abort) cuando `never_give_up`.
- [x] 1.8 Tareas `FAILED` → re-queue con `max_task_attempts=0` (ilimitado) + split/replan.
- [x] 1.9 `extension-limit` ilimitado (`max_extensions=0`) solo para soft budgets; `deadline`/`hard_budget`/`STOP`/`PAUSE`/`test-erosion` siguen duros.
- [x] 1.10 Límites `0 = off` coherentes (`max_turns`, `max_writes`, `max_failures`, `max_goal_audits`, `max_review_attempts`).
- [x] 1.11 Notificaciones `notify` en blocked→replan, review rework, goal-gaps y extensiones.
- [x] 1.12 Tests para cada transición y para que hard caps NO se puedan extender.

## Fase 2 · Calidad verificable ("100%" real)

- [x] 2.1 Baseline de checks: capturar al inicio; `applyTaskResults` exige `verify` **rojo → verde** (cuando hay baseline).
- [x] 2.2 Checks nuevos (goal-audit/replan) reciben baseline rojo; las tareas pueden completarse.
- [x] 2.3 `decideNext` no completa misión si no hubo ninguna verifying transition y quedan tareas.
- [x] 2.4 Control negativo / mutación: el check debe fallar al quitar los archivos de la tarea (activo en relentless).
- [x] 2.5 Segundo revisor con **modelo distinto** por defecto; `reviewer2` configurable.
- [x] 2.6 `stageFor` usa `maxReviewAttempts` configurable (infinito en relentless).
- [x] 2.7 `cycleDecision` respeta presupuesto duro, no el blando con auto-extend.
- [x] 2.8 anti-vacuidad reforzada en `safeCheckCmd`/`normalizePlan` (checks e2e/smoke en relentless).
- [x] 2.9 Tests: baseline, mutación, revisor distinto, budget duro, anti-vacuidad.

## Fase 3 · Paralelismo real

- [x] 3.1 Quitar cap de 8 en `maxWorkers` y en paralelismo de checks.
- [x] 3.2 Recalcular capacidad por wave (roles + workers en vuelo) y backpressure.
- [x] 3.3 Lock por archivo para escrituras concurrentes (`mission_write`).
- [x] 3.4 Worker con **re-prompt** en sesión callada antes de declarar fallo; revives acotados/infinitos.
- [x] 3.5 Herramienta `mission_spawn` para lanzar subagentes arbitrarios verificables.
- [x] 3.6 Tests: waves, locks, capacidad, spawn.

## Fase 4 · Horas-long robusto

- [x] 4.1 Watchdog externo vía archivo `WAKE` (`scripts/mission-watchdog.mjs`) + watcher interno.
- [x] 4.2 `WAKE` consume y re-admite leader; documentado en RUNBOOK (cron/systemd).
- [x] 4.3 Recuperación tras error del supervisor (1.7) sin perder progreso verificado.
- [x] 4.4 `notify` en eventos de relevancia (1.11) + webhook best-effort.
- [x] 4.5 Tests del watcher y del watchdog.

## Fase 5 · Cierre y verificación

- [x] 5.1 `npm run check`, `npm test`, `npm run quality` (coverage ~86.7/69.1/83.2) en verde: 187 tests.
- [x] 5.2 `ARCHITECTURE.md`, `CONTRACT.md`, `README.md`, `RUNBOOK.md`, `CHANGELOG.md` actualizados.
- [x] 5.3 Smoke real: `test/smoke.test.js` corre `demos/cli` con checks ejecutables hasta `complete`.
- [x] 5.4 Invariantes revisados. Módulos nuevos <250 líneas; `tui/model.js` (311) es deuda previa, `roles-pipeline`/`workers` bajaron respecto al baseline.

## Fase 6 · Incremento extra (segunda pasada)

- [x] 6.1 `strict_checks`: rechaza comandos inseguros/vacuos **antes de ejecutarlos**, también en criterios pre-autorizados (default en relentless).
- [x] 6.2 Rotación de modelo entre **todos** los modelos libres con tools, con historial durable `model_rotation` y wrap-around.
- [x] 6.3 Tests destrict/rotación + documentación (`README`, `RUNBOOK`, `CONTRACT`).
- [x] 6.4 Memoria global entre misiones (`GLOBAL_MEMORY.md`, acotada y deduplicada) inyectada en el brief.
- [x] 6.5 Tests de memoria global.

## Resultado de ejecución

- 187 tests verdes; `npm run quality` exit 0.
- Bug real corregido: `pruneJournalArchives` ordenaba por nombre (sufijo aleatorio) y podía borrar las líneas más nuevas bajo carga; ahora ordena por `mtime`.
- `demos/cli` tenía un check vacuo (`node --test` sin archivos salía exit 0); ahora exige `contains:pass 3`, por lo que el baseline es rojo y la verificación es real.

## Límites honestos (no se promete)

- `STOP`, `PAUSE`, `hard_budget_usd`, `max_wallclock_min`, `test-erosion` siguen siendo duros.
- Sin sandbox para criterios pre-autorizados (contrato: "only trusted criteria").
- "100%" solo es defendible si los checks son ejecutables reales y no vacuos; se refuerza, pero no se promete para objetivos no verificables.
