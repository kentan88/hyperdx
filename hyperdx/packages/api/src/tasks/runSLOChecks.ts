import { createNativeClient } from '@hyperdx/common-utils/dist/clickhouse/node';
import PQueue from '@esm2cjs/p-queue';
import ms from 'ms';

import * as config from '@/config';
import { injectTimeFilter } from '@/controllers/slo';
import SLO from '@/models/slo';
import { CheckSLOsTaskArgs, HdxTask } from '@/tasks/types';
import logger from '@/utils/logger';

export default class RunSLOChecksTask implements HdxTask<CheckSLOsTaskArgs> {
  constructor(private args: CheckSLOsTaskArgs) {}

  async execute(): Promise<void> {
    logger.info('Starting SLO checks...');

    // Fetch all active SLOs
    const slos = await SLO.find({});
    logger.info(`Found ${slos.length} SLOs to check`);

    const clickhouseClient = createNativeClient({
      url: config.CLICKHOUSE_HOST,
      username: config.CLICKHOUSE_USER,
      password: config.CLICKHOUSE_PASSWORD,
      request_timeout: ms('2m'),
    });

    const now = new Date();
    // Align to the last complete minute to avoid partial data
    const lastMinute = new Date(now);
    lastMinute.setSeconds(0, 0);
    const endTime = lastMinute;

    // Process SLOs in parallel with a concurrency limit
    const queue = new PQueue({ concurrency: 10 });

    for (const slo of slos) {
      queue.add(async () => {
        try {
          logger.info({ sloId: slo.id }, 'Aggregating SLO metrics');

          // 1. Determine Aggregation Window
          // Default to last minute if no previous aggregation
          // If lastAggregatedAt is present, we go from there up to now (or max 1 hour catchup)
          let startTime =
            slo.lastAggregatedAt || new Date(endTime.getTime() - ms('1m'));

          // Ensure we don't double-count or go backwards
          if (startTime >= endTime) {
            return;
          }

          // Cap at 1 hour catchup to prevent massive queries if system was down
          if (endTime.getTime() - startTime.getTime() > ms('1h')) {
            startTime = new Date(endTime.getTime() - ms('1h'));
          }

          // 2. Aggregate New Data (Incremental)
          if (slo.filter && slo.goodCondition) {
            // Builder Mode: Efficient aggregation
            const aggQuery = `
                  INSERT INTO default.slo_aggregates (slo_id, timestamp, numerator_count, denominator_count)
                  SELECT
                      '${slo.id}' as slo_id,
                      toStartOfMinute(Timestamp) as timestamp,
                      countIf(${slo.goodCondition}) as numerator_count,
                      count() as denominator_count
                  FROM default.${slo.sourceTable}
                  WHERE ${slo.filter} 
                    AND Timestamp >= '${startTime.toISOString().slice(0, 19).replace('T', ' ')}'
                    AND Timestamp < '${endTime.toISOString().slice(0, 19).replace('T', ' ')}'
                  GROUP BY timestamp
              `;
            await clickhouseClient.command({ query: aggQuery });
          } else {
            // Raw SQL Mode: Best effort aggregation (assuming count() query)
            // We inject time filter into user's query
            // Note: This inserts a SINGLE row for the window if we can't group by minute easily.
            // This is acceptable for 1-minute cron intervals.

            const numQuery = injectTimeFilter(
              slo.numeratorQuery!,
              startTime,
              endTime,
            );
            const denQuery = injectTimeFilter(
              slo.denominatorQuery!,
              startTime,
              endTime,
            );

            const [numRes, denRes] = await Promise.all([
              clickhouseClient.query({ query: numQuery, format: 'JSON' }),
              clickhouseClient.query({ query: denQuery, format: 'JSON' }),
            ]);

            const numData = await numRes.json<{
              data: Array<{ count: number }>;
            }>();
            const denData = await denRes.json<{
              data: Array<{ count: number }>;
            }>();

            const numerator = Number(numData.data?.[0]?.count || 0);
            const denominator = Number(denData.data?.[0]?.count || 0);

            if (denominator > 0 || numerator > 0) {
              await clickhouseClient.insert({
                table: 'default.slo_aggregates',
                values: [
                  {
                    slo_id: slo.id,
                    timestamp: startTime, // Attribute entire count to start of window
                    numerator_count: numerator,
                    denominator_count: denominator,
                  },
                ],
                format: 'JSONEachRow',
              });
            }
          }

          // Update last aggregated timestamp
          await SLO.updateOne({ _id: slo._id }, { lastAggregatedAt: endTime });

          // Note: We no longer compute/insert into 'slo_measurements'.
          // The API queries 'slo_aggregates' directly for status and burn rate charts.
          // This simplifies the architecture and ensures a single source of truth.
        } catch (error: any) {
          logger.error(
            {
              sloId: slo.id,
              error,
            },
            'Failed to check SLO',
          );
        }
      });
    }

    await queue.onIdle();
    logger.info('Finished SLO checks');
  }

  name(): string {
    return this.args.taskName;
  }

  async asyncDispose(): Promise<void> {
    // nothing to dispose
  }
}


