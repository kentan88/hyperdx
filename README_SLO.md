# HyperDX SLOs

Service Level Objectives (SLOs) let teams define user-centric reliability targets and operationalize error budgets. HyperDX implements event-based SLOs on ClickHouse and OpenTelemetry, inspired by Google SRE practices and Honeycomb’s event-first workflow. This README covers concepts, architecture, data model, queries, APIs, alerting, BubbleUp analysis, and operations.

## Contents

- [Concepts and goals](#concepts-and-goals)
- [Architecture overview](#architecture-overview)
- [Data model and tables](#data-model-and-tables)
- [SLI/SLO definition](#slislo-definition)
- [Aggregation and backfill](#aggregation-and-backfill)
- [Burn rates, budgets, and alerts](#burn-rates-budgets-and-alerts)
- [BubbleUp analysis](#bubbleup-analysis)
- [API and builder UX](#api-and-builder-ux)
- [Ops, scaling, and testing](#ops-scaling-and-testing)
- [Example SQL snippets](#example-sql-snippets)

## Concepts and goals

- **Event-first**: Define SLOs directly on the same raw events/traces used for debugging. Avoid pre-aggregated metrics that constrain cardinality.
- **User-centered SLIs**: Model “good vs total” for real journeys or operations (availability, latency, correctness).
- **Error budgets**: Convert targets into budgets, monitor burn, and alert on fast/slow consumption.
- **Actionable**: One click from a burning SLO to the failing event cohort and BubbleUp-style drivers.

## Architecture overview

### 1) Ingestion
- OpenTelemetry logs/traces flow into ClickHouse wide-event tables (e.g., `otel_logs` or span summaries).
- Include fields needed for SLIs: status, latency_ms, route, tenant_id, deployment, region, etc.

### 2) Incremental aggregation (every minute)
- A background task runs per minute to compute “good” and “total” counts for each active SLO over the last minute’s incremental delta.
- The task runs with parallelism (configurable, default concurrency=10) to handle many SLOs.
- It inserts minute-bucket counts into a `SummingMergeTree` table.

### 3) Status calculation (on read)
- The API computes live SLO status and burn rates directly from aggregates over rolling windows (e.g., 30 days, 24 hours, 2 hours).
- This “virtual view” approach removes the need for a separate snapshot table and ensures strict freshness.

## Data model and tables

### `slo_definitions` (MongoDB)
- Source of truth for SLO configuration.
- Fields: id, name, description, dataset/table, base_filter (total set), good_condition (boolean), target (e.g., 0.99), windows (e.g., 2h, 24h, 30d), tags, owner, alert policies, exclusions.

### `slo_aggregates` (ClickHouse)
- **Purpose**: Minute-bucket partial counts per SLO for summing over any rolling window.
- **Engine**: `SummingMergeTree`
- **Partition**: `toYYYYMM(timestamp)`
- **Order**: `(slo_id, timestamp)`
- **TTL**: 90 days
- **Columns**: `slo_id String`, `timestamp DateTime`, `numerator_count UInt64`, `denominator_count UInt64`

**Rationale**:
- `SummingMergeTree` + ordered keys enable fast range scans per SLO and efficient rolling window summations.
- TTL controls storage cost; partitions enable pruning.

## SLI/SLO definition

### Builder Mode (recommended)
- **Base Filter (total events)**: SQL WHERE fragment describing eligible events.
  - Example: `ServiceName = 'api-service' AND Body LIKE '%checkout%'`
- **Good Event Condition**: Boolean condition defining success.
  - Example: `SeverityNumber < 17 AND duration_ms <= 3000`
- **Backfill supported**: Generates efficient queries with count semantics.

### Raw SQL Mode (advanced)
- For complex SLIs where builder is insufficient.
- Backfill is limited; must return count-like aggregates for correctness and idempotency.
- **Guardrails**: validate the SQL to ensure consistent `count()` semantics.

### Journey example
- **Scope**: search → product detail → add-to-cart → checkout confirmation in ≤ 180s.
- **SLI**: good when all steps occur in order with success statuses and step latency within thresholds. Model as a journey row or materialize with a view that reduces spans to a journey event.

## Aggregation and backfill

### Minute aggregation (incremental delta)
- The background task reads the last minute of events matching `base_filter` and computes:
  - `denominator_count = count(total events)`
  - `numerator_count = count(good events)`
- Writes a row per SLO per minute into `slo_aggregates`.

### Parallelism and idempotency
- Concurrency set to 10 by default; configurable.
- Ensure idempotent inserts by computing exact minute buckets and avoiding duplicates on retries.

### Backfill
- Builder mode triggers async backfill by iterating historical minute ranges.
- Track progress to resume idempotently.

## Burn rates, budgets, and alerts

### Definitions
- **Compliance over window W**: `sum(good) / sum(total)`.
- **Error budget over W**: `(1 - target) * sum(total)`.
- **Bad events over W**: `sum(total - good)`.
- **Burn rate over W**: `bad / budget`.

### Recommended windows and thresholds
- **Fast burn**: 2h, alert if `burn_rate > 4` (page).
- **Slow burn**: 24h, alert if `burn_rate > 1` (ticket).
- **30d compliance** for reporting; `hours_to_exhaust = remaining_budget / current_burn_per_hour`.

### On-read computation
- API queries `slo_aggregates` over relevant windows per `slo_id` to compute:
  - compliance_30d, budget_remaining_30d
  - burn_rate_2h, burn_rate_24h
  - hours_to_exhaust

### Alerting
- Attach alert policies per SLO:
  - Page when `burn_rate_2h > threshold` or `hours_to_exhaust < N`.
  - Open ticket on `burn_rate_24h > threshold`.
- Integrate via webhooks, Slack, PagerDuty, etc., enriching notifications with current burn metrics and direct links to BubbleUp.

## BubbleUp analysis

### Goal
- Identify overrepresented attributes among failing events vs. successful events in a recent window (e.g., last 1–2 hours).

### Query approach
- Define “bad” cohort: `base_filter AND NOT(good_condition)` within the time window.
- Define “good” cohort: `base_filter` within the same window.
- **Sampling**: apply `SAMPLE 0.1` (or configurable) to both cohorts to bound scan cost.
- **Per-dimension analysis**:
  - For each candidate dimension (`tenant_id`, `deployment`, `az`, `endpoint`, `version`, `region`, `pod`), compute `bad_pct` and `good_pct` and a `lift = bad_pct / good_pct`.
  - Apply minimum-count thresholds (e.g., `bad_count > 10`) to avoid noise.
  - Optionally compute a significance score (e.g., chi-squared p-value or simple risk ratio CI).
- Return the top-N (e.g., 20) overrepresented values for UI display, with counts, rates, and lift.

### UI
- Show a ranked list of suspect dimensions/values.
- Provide a link to pivot into detailed event/trace views for the specific suspect value.

## API and builder UX

### Endpoints
- `POST /api/slos`
  - Creates an SLO; validates builder or raw SQL; can trigger async backfill; returns `slo_id`.
- `GET /api/slos/:id/status`
  - Computes live status from `slo_aggregates` over specified windows.
- `POST /api/slos/:id/bubbleup`
  - Accepts time range and returns top suspect dimensions with stats.

### Builder UX
- **Form fields**: name, description, dataset/table, base_filter, good_condition, target, windows, tags, owner, alert rules.
- **Preview**: shows estimated total/good counts and compliance over sample data before saving.
- **Backfill**: progress indicator and ETA.

## Ops, scaling, and testing

### Reliability
- Run the aggregator as a supervised service.
- Emit health metrics: lag (minutes behind), failures, per-SLO query latency, rows written.
- Consider queue-based fanout (e.g., per-SLO jobs) for horizontal scale and isolation.

### Performance
- ClickHouse table design:
  - Partition by month, order by `(slo_id, timestamp)`, TTL 90d.
  - Keep minute buckets compact; avoid `FINAL` unless necessary.
- Query tuning:
  - Always time bound windows.
  - Only select columns needed.
  - For BubbleUp, `SAMPLE` plus `LIMIT`s.

### Backfill
- Track `last_processed_ts` per SLO and idempotent minute ranges.
- Throttle to protect clusters; run during off-peak if possible.

### Security and tenancy
- Store tenant ownership and RBAC in `slo_definitions`.
- Filter by tenant/context in all queries.
- Avoid leaking cross-tenant aggregates.

### Load testing
- Provide a CLI or script to simulate 1M events/min via OTel, validate aggregate write rates, API latencies, and alert behavior under burn.

## Example SQL snippets

### Compute live 30d compliance
```sql
SELECT
  sum(numerator_count) / sum(denominator_count) AS compliance_30d,
  sum(denominator_count) AS total_30d,
  sum(numerator_count) AS good_30d
FROM slo_aggregates
WHERE slo_id = {slo_id}
  AND timestamp >= now() - INTERVAL 30 DAY;
```

### Compute burn_rate over a window W (e.g., 2h)
```sql
WITH
  sums AS (
    SELECT
      sum(denominator_count - numerator_count) AS bad,
      sum(denominator_count) AS total
    FROM slo_aggregates
    WHERE slo_id = {slo_id}
      AND timestamp >= now() - INTERVAL 2 HOUR
  )
SELECT
  bad / ((1 - {target}) * total) AS burn_rate_2h
FROM sums;
```

### Estimate hours_to_exhaust
- Compute `remaining_budget_30d = (1 - target) * total_30d - (total_30d - good_30d)`.
- Compute `bad_per_hour_2h = bad_2h / 2`.
- `hours_to_exhaust = remaining_budget_30d / NULLIF(bad_per_hour_2h, 0)`.

## Adapting to HyperDX Schemas

HyperDX typically points SLOs at existing OTEL-style tables (`otel_logs`, `otel_traces`), not a single “wide events” table.

### Practical Tips
- **Source tables**: Use `otel_logs` and/or `otel_traces` as your SLI data sources.
- **Field access**: Pull SLI fields from standard columns (e.g., `StatusCode`/`Duration` for traces, `SeverityNumber` for logs) and from attribute maps via `mapExtract`/`mapContains` functions.
- **Multiple sources**: For journey SLIs that span logs and traces, either evaluate per source or pre-materialize a “journey summary” view.

### ClickHouse Query Tips
- **Attribute extraction**: Use `mapContains` and `mapExtract`. For performance, consider materializing high-use attributes into dedicated columns.
- **Indices**: Leverage existing primary keys and secondary bloom indexes.
- **Virtual view**: Keep the minute-bucket SLO aggregator; it executes two `count()` queries per SLO per minute against `otel_traces` or `otel_logs` and inserts into `slo_aggregates`.

## Development

### Migrations
```bash
make dev-migrate-db
```

### Background Task
- `packages/api/src/tasks/runSLOChecks.ts`
- Runs every minute; parallel processing (default concurrency 10); incremental delta reading; idempotent minute buckets.

### API
- `POST /api/slos`: create SLO and start backfill (builder mode).
- `GET /api/slos/:id/status`: compute live status from `slo_aggregates`.
- `POST /api/slos/:id/bubbleup`: run overrepresented-attributes analysis.
