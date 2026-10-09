import prisma, { getSchema } from '@/lib/prisma';

const transaction = prisma.transaction as <T>(
  input: (tx: any) => Promise<T>,
  options?: any,
) => Promise<T>;

export interface WebsiteDataCounts {
  events: number;
  eventData: number;
  sessions: number;
  revenue: number;
  replays: number;
}

// Every statement below takes the same positional parameters:
// $1 website id, $2 range start (inclusive), $3 range end (exclusive).
const EVENTS_IN_RANGE = `website_event.website_id = $1::uuid
    and website_event.created_at >= $2
    and website_event.created_at < $3`;

// Event data is removed by two indexed statements, like the website reset does:
// its own duplicated website id and timestamp, then its parent event for legacy
// rows whose duplicates drifted. Rows matching both are removed by the first one.
const EVENT_DATA_OWN_RANGE = `event_data.website_id = $1::uuid
    and event_data.created_at >= $2
    and event_data.created_at < $3`;

const EVENT_DATA_BY_EVENT_JOIN = `event_data.website_event_id = website_event.event_id
    and ${EVENTS_IN_RANGE}`;

// Distinct event data rows removed by the two statements above.
const EVENT_DATA_UNION = `select event_data.event_data_id from event_data
    where ${EVENT_DATA_OWN_RANGE}
  union
  select event_data.event_data_id from event_data
    join website_event on ${EVENT_DATA_BY_EVENT_JOIN}`;

// Sessions whose events all fall inside the range. They are empty once the range is deleted.
// Driven from the events in range so it never walks every session of the website.
const ORPHAN_SESSIONS = `select candidate.session_id as id
  from (
    select distinct website_event.session_id from website_event where ${EVENTS_IN_RANGE}
  ) as candidate
  where not exists (
    select 1 from website_event
    where website_event.session_id = candidate.session_id
      and website_event.website_id = $1::uuid
      and (website_event.created_at < $2 or website_event.created_at >= $3 or website_event.created_at is null)
  )`;

const REPLAY_VISITS_IN_RANGE = `select distinct session_replay.visit_id as id
  from session_replay
  where session_replay.website_id = $1::uuid
    and session_replay.created_at >= $2
    and session_replay.created_at < $3`;

// Visits of orphan sessions, wherever their chunks sit. $2 is the orphan session ids.
const ORPHAN_SESSION_VISITS = `select distinct session_replay.visit_id as id
  from session_replay
  where session_replay.website_id = $1::uuid
    and session_replay.session_id = any($2::uuid[])`;

// Rows that belong to an orphan session but can sit outside the range.
const SESSION_TABLES = [
  'session_data',
  'session_link',
  'session_replay',
  'heatmap_event',
  'revenue',
] as const;

async function setSearchPath(tx: any) {
  const schema = getSchema();

  if (schema) {
    await tx.$executeRawUnsafe(`SET search_path TO "${schema}";`);
  }
}

function rangeWhere(websiteId: string, startDate: Date, endDate: Date) {
  return { websiteId, createdAt: { gte: startDate, lt: endDate } };
}

async function countRows(tx: any, sql: string, params: unknown[]): Promise<number> {
  const [{ count }] = await tx.$queryRawUnsafe(sql, ...params);

  return Number(count);
}

async function selectIds(tx: any, sql: string, params: unknown[]): Promise<string[]> {
  const rows: { id: string }[] = await tx.$queryRawUnsafe(sql, ...params);

  return rows.map(({ id }) => id);
}

export async function getWebsiteDataCounts(
  websiteId: string,
  startDate: Date,
  endDate: Date,
): Promise<WebsiteDataCounts> {
  const params = [websiteId, startDate, endDate];
  const where = rangeWhere(websiteId, startDate, endDate);

  return transaction(
    async tx => {
      await setSearchPath(tx);

      return {
        events: await tx.websiteEvent.count({ where }),
        eventData: await countRows(
          tx,
          `select count(*)::int as count from (${EVENT_DATA_UNION}) as event_data_rows`,
          params,
        ),
        sessions: await countRows(
          tx,
          `select count(*)::int as count from (${ORPHAN_SESSIONS}) as orphan`,
          params,
        ),
        revenue: await tx.revenue.count({ where }),
        replays: await countRows(
          tx,
          `select count(*)::int as count from (${REPLAY_VISITS_IN_RANGE}) as visit`,
          params,
        ),
      };
    },
    { timeout: 30000 },
  );
}

export async function clearWebsiteData(
  websiteId: string,
  startDate: Date,
  endDate: Date,
): Promise<WebsiteDataCounts> {
  const params = [websiteId, startDate, endDate];
  const where = rangeWhere(websiteId, startDate, endDate);

  return transaction(
    async tx => {
      await setSearchPath(tx);

      // Both sets depend on the rows in range, so collect them before deleting anything.
      const sessionIds = await selectIds(tx, ORPHAN_SESSIONS, params);
      const visitIds = await selectIds(tx, REPLAY_VISITS_IN_RANGE, params);
      // Orphan sessions also lose replay chunks outside the range, so their saved replays go too.
      const orphanVisitIds = sessionIds.length
        ? await selectIds(tx, ORPHAN_SESSION_VISITS, [websiteId, sessionIds])
        : [];
      const savedVisitIds = [...new Set([...visitIds, ...orphanVisitIds])];

      // Both statements are index-friendly. The second only sees rows the first left behind.
      const eventData =
        (await tx.$executeRawUnsafe(
          `delete from event_data where ${EVENT_DATA_OWN_RANGE}`,
          ...params,
        )) +
        (await tx.$executeRawUnsafe(
          `delete from event_data using website_event where ${EVENT_DATA_BY_EVENT_JOIN}`,
          ...params,
        ));
      const { count: revenue } = await tx.revenue.deleteMany({ where });

      await tx.heatmapEvent.deleteMany({ where });
      await tx.sessionReplay.deleteMany({ where });

      const { count: events } = await tx.websiteEvent.deleteMany({ where });

      let sessions = 0;

      if (sessionIds.length) {
        for (const table of SESSION_TABLES) {
          await tx.$executeRawUnsafe(
            `delete from ${table} where website_id = $1::uuid and session_id = any($2::uuid[])`,
            websiteId,
            sessionIds,
          );
        }

        sessions = await tx.$executeRawUnsafe(
          `delete from session where website_id = $1::uuid and session_id = any($2::uuid[])`,
          websiteId,
          sessionIds,
        );
      }

      if (savedVisitIds.length) {
        await tx.$executeRawUnsafe(
          `delete from session_replay_saved
          where website_id = $1::uuid
            and visit_id = any($2::uuid[])
            and not exists (
              select 1 from session_replay
              where session_replay.website_id = $1::uuid
                and session_replay.visit_id = session_replay_saved.visit_id
            )`,
          websiteId,
          savedVisitIds,
        );
      }

      return { events, eventData, sessions, revenue, replays: visitIds.length };
    },
    { timeout: 30000 },
  );
}
