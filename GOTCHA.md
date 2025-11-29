brew install golang-migrate
yarn run dev:migrate-ch


Summary of what was fixed:
Installed golang-migrate - The CLI tool needed to run ClickHouse migrations
Fixed migration 2 - Changed ORDER BY (service_name, slo_name) to ORDER BY (id, service_name, slo_name) and removed the conflicting PRIMARY KEY clause
Fixed migration 3 - Corrected SummingMergeTree(numerator_count, denominator_count) syntax to SummingMergeTree((numerator_count, denominator_count)) with proper tuple notation
Your ClickHouse database is now up to date with all migrations applied!