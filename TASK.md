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

- [x] 5.1 `npm run check`, `npm test`, `npm run quality` (coverage ~86.7/69.1/83.2) en verde: 223 tests + 17 evals end-to-end.
- [x] 5.2 `ARCHITECTURE.md`, `CONTRACT.md`, `README.md`, `RUNBOOK.md`, `CHANGELOG.md` actualizados.
- [x] 5.3 Smoke real: `test/smoke.test.js` corre `demos/cli` con checks ejecutables hasta `complete`.
- [x] 5.4 Invariantes revisados. Módulos nuevos <250 líneas; `tui/model.js` (311) es deuda previa, `roles-pipeline`/`workers` bajaron respecto al baseline.

## Fase 6 · Incremento extra (segunda pasada)

- [x] 6.1 `strict_checks`: rechaza comandos inseguros/vacuos **antes de ejecutarlos**, también en criterios pre-autorizados (default en relentless).
- [x] 6.2 Rotación de modelo entre **todos** los modelos libres con tools, con historial durable `model_rotation` y wrap-around.
- [x] 6.3 Tests destrict/rotación + documentación (`README`, `RUNBOOK`, `CONTRACT`).
- [x] 6.4 Memoria global entre misiones (`GLOBAL_MEMORY.md`, acotada y deduplicada) inyectada en el brief.
- [x] 6.5 Tests de memoria global.
- [x] 6.6 `/mission parallel A | B | C`: leads independientes, workspaces y workers por misión (hasta 8).
- [x] 6.7 `max_tokens`: contador de tokens por sesión, techo duro no extensible (útil con modelos sin precio).
- [x] 6.8 Tests de paralelismo multi-misión y tokens.
- [x] 6.9 Cola persistente priorizada (`mission-queue.json`) con `/mission queue add|list|run|clear`.
- [x] 6.10 Scheduler con `parallelSlots`, `autoQueue`, `queueIntervalMs`, `maxQueueAttempts` y recuperación tras reinicio.
- [x] 6.11 Test de carga: 8 misiones paralelas con sesiones/workspaces independientes.
- [x] 6.12 Predicción de presupuesto (`forecastBudget`) a partir de turnos/costo/tokens/historial.
- [x] 6.13 Dashboard TUI: forecast, contador de tokens y vista de la cola persistente.

## Fase 7 · Evals end-to-end integrados al motor

- [x] 7.1 `src/mission/eval.js`: scoring puro con invariantes del arnés (nunca confía en `met`).
- [x] 7.2 `scripts/mission-eval.mjs`: corre el `Supervisor` real con ctx falso determinista; sin red/modelos de pago.
- [x] 7.3 8 casos en `eval/cases/`: estándar, baseline vacuo, blocked→replan, review-high, token-budget, strict-checks, WAKE y cola paralela.
- [x] 7.4 `eval/baseline.json` con gate de regresión + `--update-baseline`, `--filter`, `--json`, `--out`.
- [x] 7.5 `npm run eval` integrado en CI (`.github/workflows/ci.yml`).
- [x] 7.6 Tests unitarios e integración de 2 casos reales bajo `node --test`.
- [x] 7.7 Docs (`README`, `RUNBOOK`, `CHANGELOG`).
- [x] 7.8 Arquitectura del runner separada: CLI (`mission-eval.mjs`, 67 líneas) + harness (`eval-harness.mjs`, 230).

## Fase 8 · Calidad de código y arquitectura

- [x] 8.1 Refactor: `turn.js`, `telemetry.js`, `task-splitting.js`, TUI `keymap.ts`/`normalize.js`.
- [x] 8.2 `src/mission.js` convertido en barrel puro (`export *`), sin listas duplicadas.
- [x] 8.3 Todos los archivos `src/**` ≤250 líneas (antes: 333/295/272/271/265/260).
- [x] 8.4 `scripts/check-architecture.mjs` integrado en `npm run check` con tests unitarios.
- [x] 8.5 3 casos eval nuevos (costo multi-sesión, memoria global, rotación) → 11/11.
- [x] 8.6 Bug real corregido: costo de workers sobrescrito al completar en el mismo turno.

## Fase 9 · Sandbox opcional de criterios

- [x] 9.1 `src/mission/sandbox.js`: modo `none|copy`, override por check, allowlist de entorno.
- [x] 9.2 `runChecks` ejecuta checks en copia desechable con `node_modules` enlazado.
- [x] 9.3 Settings `sandbox` propagados a frontmatter, prompt, verificación y `mission_check`.
- [x] 9.4 Eval `sandbox-copy`: un check que escribe `marker.txt` no toca el workspace real.
- [x] 9.5 Tests unitarios de sandbox + docs (`README`, `RUNBOOK`, `CONTRACT`, `CHANGELOG`).

## Fase 10 · Endurecimiento final de calidad

- [x] 10.1 ESLint más estricto (unused vars/empty = error, 6 reglas nuevas) y deuda corregida.
- [x] 10.2 Umbrales de cobertura subidos de 85/65/80 a 87/69/82.5.
- [x] 10.3 Nuevos tests de ramas críticas: fallos de lead/worker, goal-audit, mejoras, EXTEND, handoff y ledger.
- [x] 10.4 Bug corregido: `recordWorkerCost` actualizaba costo pero no tokens.

## Fase 11 · Limpieza de código

- [x] 11.1 Eliminadas 13 directivas `eslint-disable` y 31 constantes/imports muertos ocultos tras ellas.
- [x] 11.2 `buildDecision()` centraliza los 3 puntos donde se arma la decisión del turno.
- [x] 11.3 Chequeador de arquitectura ampliado: sin supresiones, `console.log`, TODO/FIXME ni casos eval sin baseline.
- [x] 11.4 Test unitario de las nuevas reglas de limpieza.

## Fase 12 · Supervisor de host (opt-in)

- [x] 12.1 `src/mission/host-restart.js`: decisión pura con STOP/PAUSE, stale-WAKE, backoff y techo por ventana.
- [x] 12.2 `scripts/mission-host-supervisor.mjs`: helper externo con `--dry-run`, comando configurable y ledger `host-restart.json`.
- [x] 12.3 Nunca escribe `state.json`/criteria/tasks; tras reiniciar consume `WAKE` y el watchdog interno re-admite.
- [x] 12.4 TUI muestra `host_restarts` y errores del helper.
- [x] 12.5 3 evals: reinicio básico, STOP absoluto y techo anti-loop.
- [x] 12.6 Docs (`README`, `RUNBOOK` con systemd, `ARCHITECTURE`, `CONTRACT`, `CHANGELOG`).

## Fase 13 · Context pack único

- [x] 13.1 `src/mission/context-pack.js` puro con límites explícitos y relevancia por tarea.
- [x] 13.2 `buildBrief`, `workerBrief` y briefs de roles usan el mismo pack desde disco.
- [x] 13.3 El worker ve `verify`, requisitos ligados, facts, memoria y decisiones descartadas.
- [x] 13.4 Eval `context-propagation`: el contexto durable llega al worker.

## Fase 14 · Subagentes senior

- [x] 14.1 Prompts y briefs retry-aware (`attempts`, `last_error`, "no repitas").
- [x] 14.2 Brief del worker se refresca al ser re-admitido (`scheduler.js`).
- [x] 14.3 Briefs específicos por rol vía `buildRoleBrief`.
- [x] 14.4 `validateStageReport` da corrección accionable para reviewer/auditor/goal-auditor.
- [x] 14.5 Eval `worker-retry-context`: el tercer intento recibe el error previo.

## Fase 15 · Skills

- [x] 15.1 Cuatro skills en `src/skills/*.md` con contrato estático.
- [x] 15.2 `src/skills.js` los registra vía `ctx.skill.transform` con path absoluto y `autoinvoke: false`.
- [x] 15.3 `enableSkills: false` y registro defensivo (si la API no existe, el plugin sigue vivo).

## Fase 16 · Orden y nivel senior

- [x] 16.1 `scripts/check-docs.mjs` en `npm run check`: scripts/tools/commands documentados.
- [x] 16.2 `CONTRIBUTING.md`: cómo añadir rol/skill/eval + rubrica de revisión senior.
- [x] 16.3 Arquitectura, lint, cobertura y 17 evals en verde.

## Resultado de ejecución

- 223 tests verdes; `npm run quality` exit 0; `npm run eval` 17/17 exit 0.
- Bug real corregido: `pruneJournalArchives` ordenaba por nombre (sufijo aleatorio) y podía borrar las líneas más nuevas bajo carga; ahora ordena por `mtime`.
- `demos/cli` tenía un check vacuo (`node --test` sin archivos salía exit 0); ahora exige `contains:pass 3`, por lo que el baseline es rojo y la verificación es real.

## Límites honestos (no se promete)

- `STOP`, `PAUSE`, `hard_budget_usd`, `max_wallclock_min`, `test-erosion` siguen siendo duros.
- `sandbox: copy` es un sandbox blando (copia + entorno mínimo), no namespaces de OS; no requiere root.
- El supervisor de host es opt-in y requiere un comando externo; nunca se activa solo.
- "100%" solo es defendible si los checks son ejecutables reales y no vacuos; se refuerza, pero no se promete para objetivos no verificables.
