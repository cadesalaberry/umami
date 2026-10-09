# Delete Website Data for a Date Range — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user with update permission delete a website's analytics data between two dates, with a count preview and a month-by-month delete that shows progress.

**Architecture:** A Prisma query module computes counts and deletes one range in one transaction, with shared SQL predicates so the preview and the delete agree. A new route `/api/websites/[websiteId]/clear` exposes `GET` (preview) and `POST` (delete), PostgreSQL only. The settings UI splits the range into calendar months and calls `POST` once per month, in order, through a hook that tracks progress, stop, error and retry.

**Tech Stack:** Next.js route handlers, Prisma (PostgreSQL), zod 4, React 19, `@umami/react-zen` (Calendar, ProgressBar, Dialog), TanStack Query, next-intl, date-fns, Vitest + Testing Library, Playwright API tests.

**Spec:** `docs/superpowers/specs/2026-10-08-website-clear-date-range-design.md`

## Global Constraints

- Range is half-open `[startAt, endAt)`, epoch milliseconds.
- PostgreSQL only: return `400` when `isRelationalOnly()` is false.
- Permission: `canUpdateWebsite(auth, websiteId)`, else `unauthorized()`.
- One transaction per call, `{ timeout: 30000 }`, same as `resetWebsite`.
- Raw SQL sets `search_path` from `getSchema()` before running, as the reset does.
- Count shape everywhere: `{ events, eventData, sessions, revenue, replays }`.
- Do not change `website.resetAt`, reports, segments, annotations, shares or the Redis cache.
- UI batches by calendar month in the browser timezone, ascending, one request at a time.
- New translation keys go into every `public/intl/messages/*.json` file, with English text in the non-English files.
- Package manager: run pnpm as `COREPACK_ENABLE_STRICT=0 npx pnpm@12.3.4 <script>` on this machine (`~/package.json` pins yarn). Below, `pnpm` means that command.
- Tests use `test`, not `it`. Component tests import from `@/test/render`. Test ids use `data-test`.
- Do not commit the untracked `tracker/` folder.

## Review Focus

1. A session with events on both sides of a batch boundary (for example 23:00 on Sep 30 and 01:00 on Oct 1, both inside the full range) must be kept by the first batch and deleted by the second, so the sum of deleted sessions equals the preview. Pinned by the Playwright test in Task 8 (two consecutive `POST` calls).
2. A range with tens of thousands of orphan sessions must not hit the PostgreSQL bind parameter limit. Pinned in Task 1: the session ids go to one `uuid[]` parameter.
3. A range that includes today keeps receiving events between preview and delete. The done message must show the counts returned by `POST`, not the preview. Pinned in Task 6.
4. Pressing Escape or clicking outside the dialog while a batch runs must not close it. Pinned in Task 7.
5. A double click on the confirm button must not start two delete loops. Pinned in Task 5 (`start` while running is ignored).

---

## File Structure

| File | Responsibility |
|---|---|
| Create `src/queries/prisma/websiteDataRange.ts` | SQL predicates, `getWebsiteDataCounts`, `clearWebsiteData` |
| Create `src/queries/prisma/websiteDataRange.test.ts` | Unit tests with a fake transaction |
| Modify `src/queries/prisma/index.ts` | Export the new module |
| Modify `src/app/api/websites/request-schema.ts` | `websiteDataRangeSchema` |
| Create `src/app/api/websites/[websiteId]/clear/route.ts` | `GET` preview, `POST` delete |
| Create `src/app/api/websites/[websiteId]/clear/route.test.ts` | Route unit tests |
| Generated `src/app/api/websites/[websiteId]/clear/contract.generated.ts`, `public/openapi.json` | OpenAPI artifacts |
| Modify `src/openapi/operation-ids.ts` | Operation ids |
| Create `src/app/(main)/websites/[websiteId]/settings/splitRangeByMonth.ts` (+ `.test.ts`) | Day range and month split helpers |
| Modify `src/components/messages.ts`, all `public/intl/messages/*.json` | Translation keys |
| Create `src/app/(main)/websites/[websiteId]/settings/useBatchedClear.ts` (+ `.test.ts`) | Batch loop state |
| Create `src/app/(main)/websites/[websiteId]/settings/WebsiteClearDataForm.tsx` (+ `.test.tsx`) | Dialog content: pick, confirm, run |
| Modify `src/app/(main)/websites/[websiteId]/settings/WebsiteData.tsx` (+ new `WebsiteData.test.tsx`) | New action and non-dismissable dialog |
| Create `tests/api/website-clear.spec.ts` | Real-database API test |

---

### Task 1: Query module

**Files:**
- Create: `src/queries/prisma/websiteDataRange.ts`
- Create: `src/queries/prisma/websiteDataRange.test.ts`
- Modify: `src/queries/prisma/index.ts` (add one export line after `export * from './website';`)

**Interfaces:**
- Consumes: `prisma.transaction(fn, options)` and `getSchema()` from `@/lib/prisma`.
- Produces:
  - `interface WebsiteDataCounts { events: number; eventData: number; sessions: number; revenue: number; replays: number }`
  - `getWebsiteDataCounts(websiteId: string, startDate: Date, endDate: Date): Promise<WebsiteDataCounts>`
  - `clearWebsiteData(websiteId: string, startDate: Date, endDate: Date): Promise<WebsiteDataCounts>`

- [ ] **Step 1: Write the failing test**

Create `src/queries/prisma/websiteDataRange.test.ts`:

```ts
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { clearWebsiteData, getWebsiteDataCounts } from './websiteDataRange';

const { transactionMock, getSchemaMock } = vi.hoisted(() => ({
  transactionMock: vi.fn(),
  getSchemaMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    transaction: transactionMock,
  },
  getSchema: getSchemaMock,
}));

const websiteId = '11111111-1111-4111-8111-111111111111';
const startDate = new Date('2026-09-01T00:00:00.000Z');
const endDate = new Date('2026-10-01T00:00:00.000Z');
const range = { websiteId, createdAt: { gte: startDate, lt: endDate } };

function createTx({
  sessionIds = [] as string[],
  visitIds = [] as string[],
  counts = {} as Record<string, number>,
} = {}) {
  const calls: string[] = [];
  const model = (name: string, deleted = 0) => ({
    count: vi.fn(async () => counts[name] ?? 0),
    deleteMany: vi.fn(async () => {
      calls.push(name);
      return { count: deleted };
    }),
  });

  return {
    calls,
    websiteEvent: model('websiteEvent', 40),
    revenue: model('revenue', 3),
    heatmapEvent: model('heatmapEvent'),
    sessionReplay: model('sessionReplay'),
    $queryRawUnsafe: vi.fn(async (sql: string, ..._params: unknown[]) => {
      if (sql.includes('count(*)')) {
        if (sql.includes('from event_data')) return [{ count: counts.eventData ?? 0 }];
        if (sql.includes('session.session_id')) return [{ count: counts.sessions ?? 0 }];
        if (sql.includes('session_replay.visit_id')) return [{ count: counts.replays ?? 0 }];
      }
      if (sql.includes('session.session_id')) {
        calls.push('selectSessions');
        return sessionIds.map(id => ({ id }));
      }
      if (sql.includes('session_replay.visit_id')) {
        calls.push('selectVisits');
        return visitIds.map(id => ({ id }));
      }
      throw new Error(`Unexpected query: ${sql}`);
    }),
    $executeRawUnsafe: vi.fn(async (sql: string, ..._params: unknown[]) => {
      if (sql.startsWith('SET search_path')) {
        calls.push('searchPath');
        return 0;
      }
      const table = sql.match(/^delete from (\w+)/)?.[1];
      calls.push(`raw:${table}`);
      if (table === 'event_data') return 7;
      if (table === 'session') return sessionIds.length;
      return 0;
    }),
  };
}

beforeEach(() => {
  transactionMock.mockReset();
  getSchemaMock.mockReset();
  getSchemaMock.mockReturnValue(null);
});

describe('clearWebsiteData', () => {
  test('collects orphans first, then deletes in dependency order and returns counts', async () => {
    const tx = createTx({ sessionIds: ['s1', 's2'], visitIds: ['v1'] });
    transactionMock.mockImplementation(async cb => cb(tx));

    const result = await clearWebsiteData(websiteId, startDate, endDate);

    expect(tx.calls).toEqual([
      'selectSessions',
      'selectVisits',
      'raw:event_data',
      'revenue',
      'heatmapEvent',
      'sessionReplay',
      'websiteEvent',
      'raw:session_data',
      'raw:session_link',
      'raw:session_replay',
      'raw:heatmap_event',
      'raw:revenue',
      'raw:session',
      'raw:session_replay_saved',
    ]);
    expect(result).toEqual({ events: 40, eventData: 7, sessions: 2, revenue: 3, replays: 1 });
    expect(tx.websiteEvent.deleteMany).toHaveBeenCalledWith({ where: range });
    expect(tx.revenue.deleteMany).toHaveBeenCalledWith({ where: range });
    expect(tx.heatmapEvent.deleteMany).toHaveBeenCalledWith({ where: range });
    expect(tx.sessionReplay.deleteMany).toHaveBeenCalledWith({ where: range });
    expect(transactionMock).toHaveBeenCalledWith(expect.any(Function), { timeout: 30000 });
  });

  test('passes orphan session ids as a single uuid[] parameter, however many there are', async () => {
    const sessionIds = Array.from({ length: 50_000 }, (_, i) => `session-${i}`);
    const tx = createTx({ sessionIds });
    transactionMock.mockImplementation(async cb => cb(tx));

    await clearWebsiteData(websiteId, startDate, endDate);

    const sessionDelete = tx.$executeRawUnsafe.mock.calls.find(([sql]) =>
      sql.startsWith('delete from session '),
    );
    expect(sessionDelete).toEqual([
      expect.stringContaining('session_id = any($2::uuid[])'),
      websiteId,
      sessionIds,
    ]);
  });

  test('skips session and saved replay deletes when nothing is orphaned', async () => {
    const tx = createTx();
    transactionMock.mockImplementation(async cb => cb(tx));

    const result = await clearWebsiteData(websiteId, startDate, endDate);

    expect(tx.calls).not.toContain('raw:session');
    expect(tx.calls).not.toContain('raw:session_replay_saved');
    expect(result.sessions).toBe(0);
    expect(result.replays).toBe(0);
  });

  test('orphan sessions exclude sessions with events outside the range', async () => {
    const tx = createTx();
    transactionMock.mockImplementation(async cb => cb(tx));

    await clearWebsiteData(websiteId, startDate, endDate);

    const [orphanSql, ...params] = tx.$queryRawUnsafe.mock.calls[0];
    expect(orphanSql).toContain('not exists');
    expect(orphanSql).toContain(
      'website_event.created_at < $2 or website_event.created_at >= $3',
    );
    expect(params).toEqual([websiteId, startDate, endDate]);
  });

  test('sets search_path first when the database url has a schema', async () => {
    getSchemaMock.mockReturnValue('umami');
    const tx = createTx();
    transactionMock.mockImplementation(async cb => cb(tx));

    await clearWebsiteData(websiteId, startDate, endDate);

    expect(tx.calls[0]).toBe('searchPath');
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith('SET search_path TO "umami";');
  });
});

describe('getWebsiteDataCounts', () => {
  test('returns preview counts for the range', async () => {
    const tx = createTx({
      counts: { websiteEvent: 40, revenue: 3, eventData: 7, sessions: 2, replays: 1 },
    });
    transactionMock.mockImplementation(async cb => cb(tx));

    const result = await getWebsiteDataCounts(websiteId, startDate, endDate);

    expect(result).toEqual({ events: 40, eventData: 7, sessions: 2, revenue: 3, replays: 1 });
    expect(tx.websiteEvent.count).toHaveBeenCalledWith({ where: range });
    expect(tx.revenue.count).toHaveBeenCalledWith({ where: range });
    expect(tx.websiteEvent.deleteMany).not.toHaveBeenCalled();
  });

  test('uses the same predicates as the delete', async () => {
    const previewTx = createTx();
    const clearTx = createTx({ sessionIds: ['s1'] });
    transactionMock.mockImplementationOnce(async cb => cb(previewTx));
    transactionMock.mockImplementationOnce(async cb => cb(clearTx));

    await getWebsiteDataCounts(websiteId, startDate, endDate);
    await clearWebsiteData(websiteId, startDate, endDate);

    const previewSql = previewTx.$queryRawUnsafe.mock.calls.map(([sql]) => sql).join('\n');
    const [orphanSql] = clearTx.$queryRawUnsafe.mock.calls[0];
    const [eventDataDelete] = clearTx.$executeRawUnsafe.mock.calls.find(([sql]) =>
      sql.startsWith('delete from event_data'),
    );

    expect(previewSql).toContain(orphanSql);
    expect(previewSql).toContain(eventDataDelete.replace('delete from event_data', ''));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/queries/prisma/websiteDataRange.test.ts`
Expected: FAIL, `Failed to resolve import "./websiteDataRange"`.

- [ ] **Step 3: Write the implementation**

Create `src/queries/prisma/websiteDataRange.ts`:

```ts
import prisma, { getSchema } from '@/lib/prisma';

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

// Also follows the parent event, like the reset does, for legacy rows whose
// duplicated website id or timestamp drifted from the event.
const EVENT_DATA_IN_RANGE = `(event_data.website_id = $1::uuid
    and event_data.created_at >= $2
    and event_data.created_at < $3)
  or event_data.website_event_id in (
    select website_event.event_id from website_event where ${EVENTS_IN_RANGE}
  )`;

// Sessions whose events all fall inside the range. They are empty once the range is deleted.
const ORPHAN_SESSIONS = `select session.session_id as id
  from session
  where session.website_id = $1::uuid
    and exists (
      select 1 from website_event
      where website_event.session_id = session.session_id
        and ${EVENTS_IN_RANGE}
    )
    and not exists (
      select 1 from website_event
      where website_event.session_id = session.session_id
        and website_event.website_id = $1::uuid
        and (website_event.created_at < $2 or website_event.created_at >= $3)
    )`;

const REPLAY_VISITS_IN_RANGE = `select distinct session_replay.visit_id as id
  from session_replay
  where session_replay.website_id = $1::uuid
    and session_replay.created_at >= $2
    and session_replay.created_at < $3`;

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

  return prisma.transaction(
    async (tx: any) => {
      await setSearchPath(tx);

      return {
        events: await tx.websiteEvent.count({ where }),
        eventData: await countRows(
          tx,
          `select count(*)::int as count from event_data where ${EVENT_DATA_IN_RANGE}`,
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

  return prisma.transaction(
    async (tx: any) => {
      await setSearchPath(tx);

      // Both sets depend on the rows in range, so collect them before deleting anything.
      const sessionIds = await selectIds(tx, ORPHAN_SESSIONS, params);
      const visitIds = await selectIds(tx, REPLAY_VISITS_IN_RANGE, params);

      const eventData = await tx.$executeRawUnsafe(
        `delete from event_data where ${EVENT_DATA_IN_RANGE}`,
        ...params,
      );
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

      if (visitIds.length) {
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
          visitIds,
        );
      }

      return { events, eventData, sessions, revenue, replays: visitIds.length };
    },
    { timeout: 30000 },
  );
}
```

Add to `src/queries/prisma/index.ts`, after `export * from './website';`:

```ts
export * from './websiteDataRange';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/queries/prisma/websiteDataRange.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/queries/prisma/websiteDataRange.ts src/queries/prisma/websiteDataRange.test.ts src/queries/prisma/index.ts
git commit -m "feat: add queries to count and delete website data for a date range"
```

---

### Task 2: API route and OpenAPI

**Files:**
- Modify: `src/app/api/websites/request-schema.ts` (append schema)
- Create: `src/app/api/websites/[websiteId]/clear/route.ts`
- Create: `src/app/api/websites/[websiteId]/clear/route.test.ts`
- Modify: `src/openapi/operation-ids.ts:104` (after the `reset` line)
- Generated: `src/app/api/websites/[websiteId]/clear/contract.generated.ts`, `public/openapi.json`, and any file `pnpm generate:api` changes

**Interfaces:**
- Consumes: `getWebsiteDataCounts`, `clearWebsiteData`, `WebsiteDataCounts` from `@/queries/prisma` (Task 1).
- Produces:
  - `GET /api/websites/{websiteId}/clear?startAt=<ms>&endAt=<ms>` returns `WebsiteDataCounts` JSON.
  - `POST /api/websites/{websiteId}/clear` with JSON body `{ startAt: number, endAt: number }` returns `WebsiteDataCounts` JSON.
  - `websiteDataRangeSchema` from `src/app/api/websites/request-schema.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/websites/[websiteId]/clear/route.test.ts`:

```ts
import { beforeEach, expect, test, vi } from 'vitest';
import { isRelationalOnly } from '@/lib/db';
import { parseRequest } from '@/lib/request';
import { canUpdateWebsite } from '@/permissions';
import { clearWebsiteData, getWebsiteDataCounts } from '@/queries/prisma';
import { websiteDataRangeSchema } from '../../request-schema';
import { GET, POST } from './route';

vi.mock('@/lib/db', () => ({
  isRelationalOnly: vi.fn(),
}));

vi.mock('@/lib/request', () => ({
  parseRequest: vi.fn(),
}));

vi.mock('@/permissions', () => ({
  canUpdateWebsite: vi.fn(),
}));

vi.mock('@/queries/prisma', () => ({
  clearWebsiteData: vi.fn(),
  getWebsiteDataCounts: vi.fn(),
}));

const isRelationalOnlyMock = vi.mocked(isRelationalOnly);
const parseRequestMock = vi.mocked(parseRequest);
const canUpdateWebsiteMock = vi.mocked(canUpdateWebsite);
const clearWebsiteDataMock = vi.mocked(clearWebsiteData);
const getWebsiteDataCountsMock = vi.mocked(getWebsiteDataCounts);

const counts = { events: 40, eventData: 7, sessions: 2, revenue: 3, replays: 1 };
const startAt = Date.UTC(2026, 8, 1);
const endAt = Date.UTC(2026, 9, 1);
const context = { params: Promise.resolve({ websiteId: 'website-1' }) };

beforeEach(() => {
  isRelationalOnlyMock.mockReset();
  parseRequestMock.mockReset();
  canUpdateWebsiteMock.mockReset();
  clearWebsiteDataMock.mockReset();
  getWebsiteDataCountsMock.mockReset();
  isRelationalOnlyMock.mockReturnValue(true);
  canUpdateWebsiteMock.mockResolvedValue(true);
});

test('schema rejects a range whose start is not before its end', () => {
  expect(websiteDataRangeSchema.safeParse({ startAt: endAt, endAt: startAt }).success).toBe(false);
  expect(websiteDataRangeSchema.safeParse({ startAt, endAt: startAt }).success).toBe(false);
  expect(websiteDataRangeSchema.safeParse({ startAt: 'x', endAt }).success).toBe(false);
  expect(websiteDataRangeSchema.safeParse({ startAt: `${startAt}`, endAt: `${endAt}` }).data).toEqual(
    { startAt, endAt },
  );
});

test('GET returns the parse error', async () => {
  parseRequestMock.mockResolvedValue({ error: () => Response.json({}, { status: 400 }) });

  const response = await GET(new Request('http://localhost/api/websites/website-1/clear'), context);

  expect(response.status).toBe(400);
  expect(getWebsiteDataCountsMock).not.toHaveBeenCalled();
});

test('GET returns bad request without relational storage', async () => {
  parseRequestMock.mockResolvedValue({ auth: {}, query: { startAt, endAt } });
  isRelationalOnlyMock.mockReturnValue(false);

  const response = await GET(new Request('http://localhost/api/websites/website-1/clear'), context);

  expect(response.status).toBe(400);
  expect(getWebsiteDataCountsMock).not.toHaveBeenCalled();
});

test('GET returns unauthorized without update permission', async () => {
  parseRequestMock.mockResolvedValue({ auth: {}, query: { startAt, endAt } });
  canUpdateWebsiteMock.mockResolvedValue(false);

  const response = await GET(new Request('http://localhost/api/websites/website-1/clear'), context);

  expect(response.status).toBe(401);
  expect(getWebsiteDataCountsMock).not.toHaveBeenCalled();
});

test('GET returns preview counts', async () => {
  parseRequestMock.mockResolvedValue({ auth: { user: {} }, query: { startAt, endAt } });
  getWebsiteDataCountsMock.mockResolvedValue(counts);

  const response = await GET(new Request('http://localhost/api/websites/website-1/clear'), context);

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual(counts);
  expect(canUpdateWebsiteMock).toHaveBeenCalledWith({ user: {} }, 'website-1');
  expect(getWebsiteDataCountsMock).toHaveBeenCalledWith(
    'website-1',
    new Date(startAt),
    new Date(endAt),
  );
});

test('POST returns bad request without relational storage', async () => {
  parseRequestMock.mockResolvedValue({ auth: {}, body: { startAt, endAt } });
  isRelationalOnlyMock.mockReturnValue(false);

  const response = await POST(
    new Request('http://localhost/api/websites/website-1/clear', { method: 'POST' }),
    context,
  );

  expect(response.status).toBe(400);
  expect(clearWebsiteDataMock).not.toHaveBeenCalled();
});

test('POST returns unauthorized without update permission', async () => {
  parseRequestMock.mockResolvedValue({ auth: {}, body: { startAt, endAt } });
  canUpdateWebsiteMock.mockResolvedValue(false);

  const response = await POST(
    new Request('http://localhost/api/websites/website-1/clear', { method: 'POST' }),
    context,
  );

  expect(response.status).toBe(401);
  expect(clearWebsiteDataMock).not.toHaveBeenCalled();
});

test('POST deletes the range and returns deleted counts', async () => {
  parseRequestMock.mockResolvedValue({ auth: {}, body: { startAt, endAt } });
  clearWebsiteDataMock.mockResolvedValue(counts);

  const response = await POST(
    new Request('http://localhost/api/websites/website-1/clear', { method: 'POST' }),
    context,
  );

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual(counts);
  expect(clearWebsiteDataMock).toHaveBeenCalledWith(
    'website-1',
    new Date(startAt),
    new Date(endAt),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run "src/app/api/websites/[websiteId]/clear/route.test.ts"`
Expected: FAIL, cannot resolve `./route` (and `websiteDataRangeSchema` is undefined).

- [ ] **Step 3: Write the implementation**

Append to `src/app/api/websites/request-schema.ts`:

```ts
export const websiteDataRangeSchema = z
  .object({
    startAt: z.coerce.number().int().nonnegative(),
    endAt: z.coerce.number().int().positive(),
  })
  .refine(({ startAt, endAt }) => startAt < endAt, {
    message: 'startAt must be before endAt',
    path: ['endAt'],
  })
  .meta({ id: 'WebsiteDataRange' });
```

Create `src/app/api/websites/[websiteId]/clear/route.ts`:

```ts
import { isRelationalOnly } from '@/lib/db';
import { parseRequest } from '@/lib/request';
import { badRequest, json, unauthorized } from '@/lib/response';
import { canUpdateWebsite } from '@/permissions';
import { clearWebsiteData, getWebsiteDataCounts } from '@/queries/prisma';
import { websiteDataRangeSchema } from '../../request-schema';

const RELATIONAL_ONLY_MESSAGE =
  'Deleting data for a date range is only available with relational storage.';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const { auth, query, error } = await parseRequest(request, websiteDataRangeSchema);

  if (error) {
    return error();
  }

  if (!isRelationalOnly()) {
    return badRequest({ message: RELATIONAL_ONLY_MESSAGE });
  }

  const { websiteId } = await params;

  if (!(await canUpdateWebsite(auth, websiteId))) {
    return unauthorized();
  }

  const counts = await getWebsiteDataCounts(
    websiteId,
    new Date(query.startAt),
    new Date(query.endAt),
  );

  return json({ ...counts });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const { auth, body, error } = await parseRequest(request, websiteDataRangeSchema);

  if (error) {
    return error();
  }

  if (!isRelationalOnly()) {
    return badRequest({ message: RELATIONAL_ONLY_MESSAGE });
  }

  const { websiteId } = await params;

  if (!(await canUpdateWebsite(auth, websiteId))) {
    return unauthorized();
  }

  const counts = await clearWebsiteData(websiteId, new Date(body.startAt), new Date(body.endAt));

  return json({ ...counts });
}
```

In `src/openapi/operation-ids.ts`, after `'POST /api/websites/{websiteId}/reset': 'resetWebsite',` add:

```ts
  'GET /api/websites/{websiteId}/clear': 'getWebsiteClearPreview',
  'POST /api/websites/{websiteId}/clear': 'clearWebsiteData',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run "src/app/api/websites/[websiteId]/clear/route.test.ts"`
Expected: PASS, 8 tests.

- [ ] **Step 5: Regenerate OpenAPI artifacts**

Run: `pnpm openapi:contracts && pnpm generate:api && pnpm openapi:check`
Expected: `src/app/api/websites/[websiteId]/clear/contract.generated.ts` exists with operation ids `getWebsiteClearPreview` and `clearWebsiteData`; `openapi:check` exits 0 and reports no stale file. Open the contract and confirm that `GET` lists `startAt`/`endAt` query parameters and `POST` has a request body. If inference did not pick up the schema, read how `src/openapi/infer.ts` detects `parseRequest(request, <schema>)` and fix the route so it matches, then rerun.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/websites/request-schema.ts "src/app/api/websites/[websiteId]/clear" src/openapi/operation-ids.ts public/openapi.json
git status --short   # add any other file changed by generate:api
git commit -m "feat: add API to preview and delete website data for a date range"
```

---

### Task 3: Day range and month split helpers

**Files:**
- Create: `src/app/(main)/websites/[websiteId]/settings/splitRangeByMonth.ts`
- Create: `src/app/(main)/websites/[websiteId]/settings/splitRangeByMonth.test.ts`

**Interfaces:**
- Produces:
  - `interface MonthRange { startAt: number; endAt: number }`
  - `toDayRange(from: Date, to: Date): MonthRange` — `[startOfDay(from), startOfDay(to + 1 day))`, local time.
  - `splitRangeByMonth(startAt: number, endAt: number): MonthRange[]` — calendar months, local time, first and last clipped, ascending, contiguous. Returns `[]` when `startAt >= endAt`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from 'vitest';
import { splitRangeByMonth, toDayRange } from './splitRangeByMonth';

const at = (year: number, month: number, day: number) => new Date(year, month, day).getTime();

describe('toDayRange', () => {
  test('covers whole days with an exclusive end', () => {
    expect(toDayRange(new Date(2026, 9, 3, 15, 30), new Date(2026, 9, 3, 9))).toEqual({
      startAt: at(2026, 9, 3),
      endAt: at(2026, 9, 4),
    });
  });
});

describe('splitRangeByMonth', () => {
  test('keeps a range inside one month as one batch', () => {
    expect(splitRangeByMonth(at(2026, 9, 3), at(2026, 9, 10))).toEqual([
      { startAt: at(2026, 9, 3), endAt: at(2026, 9, 10) },
    ]);
  });

  test('clips the first and last months', () => {
    expect(splitRangeByMonth(at(2026, 8, 15), at(2026, 10, 11))).toEqual([
      { startAt: at(2026, 8, 15), endAt: at(2026, 9, 1) },
      { startAt: at(2026, 9, 1), endAt: at(2026, 10, 1) },
      { startAt: at(2026, 10, 1), endAt: at(2026, 10, 11) },
    ]);
  });

  test('crosses a year boundary', () => {
    expect(splitRangeByMonth(at(2026, 11, 20), at(2027, 0, 6))).toEqual([
      { startAt: at(2026, 11, 20), endAt: at(2027, 0, 1) },
      { startAt: at(2027, 0, 1), endAt: at(2027, 0, 6) },
    ]);
  });

  test('returns no batch for an empty or inverted range', () => {
    expect(splitRangeByMonth(at(2026, 9, 3), at(2026, 9, 3))).toEqual([]);
    expect(splitRangeByMonth(at(2026, 9, 4), at(2026, 9, 3))).toEqual([]);
  });

  test('batches are contiguous and start at local midnight on the 1st, across DST changes', () => {
    const batches = splitRangeByMonth(at(2026, 0, 15), at(2027, 2, 15));

    expect(batches).toHaveLength(15);
    batches.slice(1).forEach((batch, index) => {
      const start = new Date(batch.startAt);

      expect(batch.startAt).toBe(batches[index].endAt);
      expect(start.getDate()).toBe(1);
      expect(start.getHours()).toBe(0);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run "src/app/(main)/websites/[websiteId]/settings/splitRangeByMonth.test.ts"`
Expected: FAIL, cannot resolve `./splitRangeByMonth`.

- [ ] **Step 3: Write the implementation**

```ts
import { addDays, addMonths, startOfDay, startOfMonth } from 'date-fns';

export interface MonthRange {
  startAt: number;
  endAt: number;
}

export function toDayRange(from: Date, to: Date): MonthRange {
  return {
    startAt: startOfDay(from).getTime(),
    endAt: startOfDay(addDays(to, 1)).getTime(),
  };
}

// Splits [startAt, endAt) into calendar months in the browser timezone.
export function splitRangeByMonth(startAt: number, endAt: number): MonthRange[] {
  const ranges: MonthRange[] = [];
  let cursor = startAt;

  while (cursor < endAt) {
    const next = Math.min(startOfMonth(addMonths(cursor, 1)).getTime(), endAt);

    ranges.push({ startAt: cursor, endAt: next });
    cursor = next;
  }

  return ranges;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run "src/app/(main)/websites/[websiteId]/settings/splitRangeByMonth.test.ts"`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(main)/websites/[websiteId]/settings/splitRangeByMonth.ts" "src/app/(main)/websites/[websiteId]/settings/splitRangeByMonth.test.ts"
git commit -m "feat: add helper to split a date range into calendar months"
```

---

### Task 4: Translation keys

**Files:**
- Modify: `src/components/messages.ts` (labels near `resetWebsite`, line ~60; messages after `resetWebsiteWarning`, line ~463)
- Modify: all 54 files in `public/intl/messages/`

**Interfaces:**
- Produces: `labels.deleteData`, `labels.retry`, `labels.stop`; `messages.deleteDataWarning`, `deleteDataConfirm`, `deleteDataEvents`, `deleteDataEventData`, `deleteDataSessions`, `deleteDataRevenue`, `deleteDataReplays`, `deleteDataEmpty`, `deleteDataProgress`, `deleteDataTotals`, `deleteDataError`, `deleteDataStopped`, `deleteDataDone`. Message arguments: count messages take `x`; `deleteDataConfirm` takes `startDate`, `endDate`; `deleteDataProgress` takes `month`, `current`, `total`; `deleteDataTotals` and `deleteDataDone` take `events`, `sessions`; `deleteDataError` and `deleteDataStopped` take `month`.

- [ ] **Step 1: Add keys to `messages.ts`**

In `labels`, after `resetWebsite: 'label.reset-website',`:

```ts
  deleteData: 'label.delete-data',
  retry: 'label.retry',
  stop: 'label.stop',
```

In `messages`, after `resetWebsiteWarning: 'message.reset-website-warning',`:

```ts
  deleteDataWarning: 'message.delete-data-warning',
  deleteDataConfirm: 'message.delete-data-confirm',
  deleteDataEvents: 'message.delete-data-events',
  deleteDataEventData: 'message.delete-data-event-data',
  deleteDataSessions: 'message.delete-data-sessions',
  deleteDataRevenue: 'message.delete-data-revenue',
  deleteDataReplays: 'message.delete-data-replays',
  deleteDataEmpty: 'message.delete-data-empty',
  deleteDataProgress: 'message.delete-data-progress',
  deleteDataTotals: 'message.delete-data-totals',
  deleteDataError: 'message.delete-data-error',
  deleteDataStopped: 'message.delete-data-stopped',
  deleteDataDone: 'message.delete-data-done',
```

- [ ] **Step 2: Add keys to every locale file**

Locale files do not share one key order, so insert after an anchor key and keep the rest of each file as it is. Create `scripts/tmp-add-messages.mjs` (do not commit it):

```js
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const dir = 'public/intl/messages';
const additions = {
  label: {
    after: 'reset-website',
    keys: {
      'delete-data': 'Delete data',
      retry: 'Retry',
      stop: 'Stop',
    },
  },
  message: {
    after: 'reset-website-warning',
    keys: {
      'delete-data-warning':
        'Permanently delete all statistics recorded between two dates. Your settings will remain intact.',
      'delete-data-confirm':
        'The following data recorded between {startDate} and {endDate} will be permanently deleted:',
      'delete-data-events': '{x, number} {x, plural, one {event} other {events}}',
      'delete-data-event-data':
        '{x, number} event data {x, plural, one {property} other {properties}}',
      'delete-data-sessions': '{x, number} {x, plural, one {session} other {sessions}}',
      'delete-data-revenue': '{x, number} revenue {x, plural, one {record} other {records}}',
      'delete-data-replays': '{x, number} session {x, plural, one {replay} other {replays}}',
      'delete-data-empty': 'No data found in this date range.',
      'delete-data-progress': 'Deleting {month} ({current} of {total})',
      'delete-data-totals':
        'Deleted so far: {events, number} {events, plural, one {event} other {events}}, {sessions, number} {sessions, plural, one {session} other {sessions}}.',
      'delete-data-error': 'Failed to delete data for {month}. Earlier months were deleted.',
      'delete-data-stopped': 'Deletion stopped. Data after {month} was not deleted.',
      'delete-data-done':
        'Data deleted: {events, number} {events, plural, one {event} other {events}}, {sessions, number} {sessions, plural, one {session} other {sessions}}.',
    },
  },
};

for (const file of readdirSync(dir).filter(name => name.endsWith('.json'))) {
  const path = `${dir}/${file}`;
  const raw = readFileSync(path, 'utf8');
  const newline = raw.includes('\r\n') ? '\r\n' : '\n';
  const data = JSON.parse(raw);

  for (const [section, { after, keys }] of Object.entries(additions)) {
    const existing = data[section] ?? {};
    const entries = Object.entries(existing).filter(([key]) => !(key in keys));
    const index = entries.findIndex(([key]) => key === after);
    const position = index === -1 ? entries.length : index + 1;

    entries.splice(
      position,
      0,
      ...Object.entries(keys).map(([key, value]) => [key, existing[key] ?? value]),
    );
    data[section] = Object.fromEntries(entries);
  }

  writeFileSync(path, `${JSON.stringify(data, null, 2).replace(/\n/g, newline)}${newline}`, 'utf8');
}
```

Run: `node scripts/tmp-add-messages.mjs && rm scripts/tmp-add-messages.mjs`

- [ ] **Step 3: Verify**

Run: `git diff --stat public/intl/messages | tail -3 && pnpm check:messages`
Expected: about 16 insertions and 0 to 2 deletions per file (a deletion only where the anchor was the last key and gained a comma). `check:messages` prints `Total missing across all locales: 0`. If a file shows hundreds of changed lines, the serialization changed that file (for example escaped unicode): revert it with `git checkout -- <file>` and add the keys to it by hand.

- [ ] **Step 4: Commit**

```bash
git add src/components/messages.ts public/intl/messages
git commit -m "feat: add translations for deleting website data by date range"
```

---

### Task 5: Batch hook

**Files:**
- Create: `src/app/(main)/websites/[websiteId]/settings/useBatchedClear.ts`
- Create: `src/app/(main)/websites/[websiteId]/settings/useBatchedClear.test.ts`

**Interfaces:**
- Consumes: `useApi().post(url, params)` from `@/components/hooks`; `MonthRange` from Task 3; the `POST /clear` response shape from Task 2.
- Produces:
  - `type ClearCounts = { events: number; eventData: number; sessions: number; revenue: number; replays: number }`
  - `EMPTY_COUNTS: ClearCounts`
  - `type BatchStatus = 'idle' | 'running' | 'stopping' | 'stopped' | 'error' | 'done'`
  - `useBatchedClear(websiteId: string)` returns `{ months: MonthRange[]; completed: number; current?: MonthRange; totals: ClearCounts; status: BatchStatus; error?: Error; isBusy: boolean; start(months: MonthRange[]): Promise<void>; stop(): void; retry(): Promise<void> }`. `completed` is the number of months already deleted. `current` is `months[completed]`, the month in progress or the month that failed.

- [ ] **Step 1: Write the failing test**

```ts
import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { useBatchedClear } from './useBatchedClear';

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));

vi.mock('@/components/hooks', () => ({
  useApi: () => ({ post: postMock }),
}));

const months = [
  { startAt: 1, endAt: 2 },
  { startAt: 2, endAt: 3 },
  { startAt: 3, endAt: 4 },
];
const counts = (events: number, sessions = 0) => ({
  events,
  eventData: 0,
  sessions,
  revenue: 0,
  replays: 0,
});

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  postMock.mockReset();
});

test('deletes months in order and sums the returned counts', async () => {
  postMock
    .mockResolvedValueOnce(counts(10, 1))
    .mockResolvedValueOnce(counts(20, 2))
    .mockResolvedValueOnce(counts(30, 3));
  const { result } = renderHook(() => useBatchedClear('website-1'));

  await act(() => result.current.start(months));

  expect(postMock.mock.calls).toEqual(months.map(month => ['/websites/website-1/clear', month]));
  expect(result.current.status).toBe('done');
  expect(result.current.completed).toBe(3);
  expect(result.current.totals).toEqual(counts(60, 6));
});

test('stop finishes the current month, then stops', async () => {
  const first = deferred<ReturnType<typeof counts>>();
  postMock.mockReturnValueOnce(first.promise);
  const { result } = renderHook(() => useBatchedClear('website-1'));

  let running: Promise<void> = Promise.resolve();
  act(() => {
    running = result.current.start(months);
  });
  act(() => result.current.stop());
  expect(result.current.status).toBe('stopping');

  await act(async () => {
    first.resolve(counts(10));
    await running;
  });

  expect(postMock).toHaveBeenCalledTimes(1);
  expect(result.current.status).toBe('stopped');
  expect(result.current.completed).toBe(1);
});

test('retry resumes from the failed month', async () => {
  postMock
    .mockResolvedValueOnce(counts(10))
    .mockRejectedValueOnce(new Error('timeout'))
    .mockResolvedValueOnce(counts(20))
    .mockResolvedValueOnce(counts(30));
  const { result } = renderHook(() => useBatchedClear('website-1'));

  await act(() => result.current.start(months));

  expect(result.current.status).toBe('error');
  expect(result.current.error?.message).toBe('timeout');
  expect(result.current.current).toEqual(months[1]);

  await act(() => result.current.retry());

  expect(postMock.mock.calls.map(([, month]) => month)).toEqual([
    months[0],
    months[1],
    months[1],
    months[2],
  ]);
  expect(result.current.status).toBe('done');
  expect(result.current.totals.events).toBe(60);
});

test('ignores a second start while running', async () => {
  postMock.mockResolvedValue(counts(1));
  const { result } = renderHook(() => useBatchedClear('website-1'));

  await act(async () => {
    const first = result.current.start(months);
    const second = result.current.start(months);
    await Promise.all([first, second]);
  });

  expect(postMock).toHaveBeenCalledTimes(3);
});

test('warns before unload only while running', async () => {
  const first = deferred<ReturnType<typeof counts>>();
  postMock.mockReturnValueOnce(first.promise);
  const { result } = renderHook(() => useBatchedClear('website-1'));
  const unload = () => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };

  let running: Promise<void> = Promise.resolve();
  act(() => {
    running = result.current.start([months[0]]);
  });
  expect(unload()).toBe(true);

  await act(async () => {
    first.resolve(counts(1));
    await running;
  });
  expect(unload()).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run "src/app/(main)/websites/[websiteId]/settings/useBatchedClear.test.ts"`
Expected: FAIL, cannot resolve `./useBatchedClear`.

- [ ] **Step 3: Write the implementation**

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '@/components/hooks';
import type { MonthRange } from './splitRangeByMonth';

export interface ClearCounts {
  events: number;
  eventData: number;
  sessions: number;
  revenue: number;
  replays: number;
}

export const EMPTY_COUNTS: ClearCounts = {
  events: 0,
  eventData: 0,
  sessions: 0,
  revenue: 0,
  replays: 0,
};

export type BatchStatus = 'idle' | 'running' | 'stopping' | 'stopped' | 'error' | 'done';

function addCounts(total: ClearCounts, counts: Partial<ClearCounts>): ClearCounts {
  return {
    events: total.events + (counts?.events ?? 0),
    eventData: total.eventData + (counts?.eventData ?? 0),
    sessions: total.sessions + (counts?.sessions ?? 0),
    revenue: total.revenue + (counts?.revenue ?? 0),
    replays: total.replays + (counts?.replays ?? 0),
  };
}

export function useBatchedClear(websiteId: string) {
  const { post } = useApi();
  const [months, setMonths] = useState<MonthRange[]>([]);
  const [completed, setCompleted] = useState(0);
  const [totals, setTotals] = useState<ClearCounts>(EMPTY_COUNTS);
  const [status, setStatus] = useState<BatchStatus>('idle');
  const [error, setError] = useState<Error>();
  const running = useRef(false);
  const stopRequested = useRef(false);

  const run = useCallback(
    async (ranges: MonthRange[], from: number) => {
      if (running.current) {
        return;
      }

      running.current = true;
      stopRequested.current = false;
      setStatus('running');
      setError(undefined);

      try {
        for (let index = from; index < ranges.length; index++) {
          if (stopRequested.current) {
            setStatus('stopped');
            return;
          }

          const counts = await post(`/websites/${websiteId}/clear`, ranges[index]);

          setTotals(total => addCounts(total, counts));
          setCompleted(index + 1);
        }

        setStatus('done');
      } catch (e) {
        setError(e as Error);
        setStatus('error');
      } finally {
        running.current = false;
      }
    },
    [post, websiteId],
  );

  const start = useCallback(
    async (ranges: MonthRange[]) => {
      if (running.current) {
        return;
      }

      setMonths(ranges);
      setCompleted(0);
      setTotals(EMPTY_COUNTS);

      await run(ranges, 0);
    },
    [run],
  );

  const retry = useCallback(() => run(months, completed), [run, months, completed]);

  const stop = useCallback(() => {
    if (running.current) {
      stopRequested.current = true;
      setStatus('stopping');
    }
  }, []);

  const isBusy = status === 'running' || status === 'stopping';

  useEffect(() => {
    if (!isBusy) {
      return;
    }

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isBusy]);

  return {
    months,
    completed,
    current: months[completed],
    totals,
    status,
    error,
    isBusy,
    start,
    stop,
    retry,
  };
}
```

Note: the second `start` in the double-start test runs before React re-renders, so it reads `running.current === true` and returns. That ref check is the guard; do not replace it with the `status` state.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run "src/app/(main)/websites/[websiteId]/settings/useBatchedClear.test.ts"`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(main)/websites/[websiteId]/settings/useBatchedClear.ts" "src/app/(main)/websites/[websiteId]/settings/useBatchedClear.test.ts"
git commit -m "feat: add hook that deletes website data month by month"
```

---

### Task 6: Clear data form

**Files:**
- Create: `src/app/(main)/websites/[websiteId]/settings/WebsiteClearDataForm.tsx`
- Create: `src/app/(main)/websites/[websiteId]/settings/WebsiteClearDataForm.test.tsx`

**Interfaces:**
- Consumes: `useBatchedClear`, `ClearCounts` (Task 5); `toDayRange`, `splitRangeByMonth` (Task 3); message keys (Task 4); `GET /clear` (Task 2); `TypeConfirmationForm` from `@/components/common/TypeConfirmationForm`; `formatDate` from `@/lib/date`; `useApi`, `useLocale`, `useMessages` from `@/components/hooks`.
- Produces: `WebsiteClearDataForm({ websiteId, defaultRange?, onSave?, onClose?, onBusyChange? })` where `defaultRange?: { from: Date; to: Date }` (default: today to today) and `onBusyChange?: (busy: boolean) => void`.

- [ ] **Step 1: Write the failing test**

```tsx
import { useMutation, useQuery } from '@tanstack/react-query';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import { WebsiteClearDataForm } from './WebsiteClearDataForm';

const { getMock, postMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn() }));

vi.mock('@/components/hooks', async importOriginal => ({
  ...(await importOriginal<typeof import('@/components/hooks')>()),
  useApi: () => ({ get: getMock, post: postMock, useQuery, useMutation }),
}));

const counts = (values: Partial<Record<string, number>>) => ({
  events: 0,
  eventData: 0,
  sessions: 0,
  revenue: 0,
  replays: 0,
  ...values,
});

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

const twoMonths = { from: new Date(2026, 8, 15), to: new Date(2026, 9, 3) };

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
});

describe('WebsiteClearDataForm', () => {
  test('previews non-zero counts and requires typing DELETE', async () => {
    getMock.mockResolvedValue(counts({ events: 1234, sessions: 56 }));
    const { user } = render(<WebsiteClearDataForm websiteId="website-1" defaultRange={twoMonths} />);

    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('1,234 events')).toBeInTheDocument();
    expect(screen.getByText('56 sessions')).toBeInTheDocument();
    expect(screen.queryByText(/event data/)).not.toBeInTheDocument();
    expect(getMock).toHaveBeenCalledWith('/websites/website-1/clear', {
      startAt: new Date(2026, 8, 15).getTime(),
      endAt: new Date(2026, 9, 4).getTime(),
    });

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(postMock).not.toHaveBeenCalled();
  });

  test('shows a message and no confirmation when the range is empty', async () => {
    getMock.mockResolvedValue(counts({}));
    const { user } = render(<WebsiteClearDataForm websiteId="website-1" />);

    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('No data found in this date range.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Confirm')).not.toBeInTheDocument();
  });

  test('deletes month by month with progress and reports the counts actually deleted', async () => {
    getMock.mockResolvedValue(counts({ events: 9999, sessions: 999 }));
    const september = deferred<ReturnType<typeof counts>>();
    const october = deferred<ReturnType<typeof counts>>();
    postMock.mockReturnValueOnce(september.promise).mockReturnValueOnce(october.promise);
    const onBusyChange = vi.fn();
    const onSave = vi.fn();
    const onClose = vi.fn();
    const { user } = render(
      <WebsiteClearDataForm
        websiteId="website-1"
        defaultRange={twoMonths}
        onBusyChange={onBusyChange}
        onSave={onSave}
        onClose={onClose}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(await screen.findByLabelText('Confirm'), 'DELETE');
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText('Deleting September 2026 (1 of 2)')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(onBusyChange).toHaveBeenLastCalledWith(true);

    september.resolve(counts({ events: 10, sessions: 2 }));
    expect(await screen.findByText('Deleting October 2026 (2 of 2)')).toBeInTheDocument();
    expect(screen.getByText('Deleted so far: 10 events, 2 sessions.')).toBeInTheDocument();

    october.resolve(counts({ events: 5, sessions: 1 }));
    expect(await screen.findByText('Data deleted: 15 events, 3 sessions.')).toBeInTheDocument();
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(false));

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onSave).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  test('offers retry after a failed month', async () => {
    getMock.mockResolvedValue(counts({ events: 5 }));
    postMock
      .mockRejectedValueOnce(new Error('Request timed out'))
      .mockResolvedValueOnce(counts({ events: 5 }))
      .mockResolvedValueOnce(counts({ events: 1 }));
    const { user } = render(<WebsiteClearDataForm websiteId="website-1" defaultRange={twoMonths} />);

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(await screen.findByLabelText('Confirm'), 'DELETE');
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(
      await screen.findByText('Failed to delete data for September 2026. Earlier months were deleted.'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Data deleted: 6 events, 0 sessions.')).toBeInTheDocument();
    expect(postMock).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run "src/app/(main)/websites/[websiteId]/settings/WebsiteClearDataForm.test.tsx"`
Expected: FAIL, cannot resolve `./WebsiteClearDataForm`.

- [ ] **Step 3: Write the implementation**

```tsx
import { Button, Calendar, Column, Loading, ProgressBar, Row, Text } from '@umami/react-zen';
import { useEffect, useMemo, useState } from 'react';
import { TypeConfirmationForm } from '@/components/common/TypeConfirmationForm';
import { useApi, useLocale, useMessages } from '@/components/hooks';
import { formatDate } from '@/lib/date';
import { type MonthRange, splitRangeByMonth, toDayRange } from './splitRangeByMonth';
import { type ClearCounts, useBatchedClear } from './useBatchedClear';

const CONFIRM_VALUE = 'DELETE';

type Step = 'pick' | 'confirm' | 'run';

export function WebsiteClearDataForm({
  websiteId,
  defaultRange,
  onSave,
  onClose,
  onBusyChange,
}: {
  websiteId: string;
  defaultRange?: { from: Date; to: Date };
  onSave?: () => void;
  onClose?: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t, labels, messages, getErrorMessage } = useMessages();
  const { locale } = useLocale();
  const { get, useQuery } = useApi();
  const [step, setStep] = useState<Step>('pick');
  const [selection, setSelection] = useState<{ from?: Date; to?: Date }>(
    () => defaultRange ?? { from: new Date(), to: new Date() },
  );
  const batch = useBatchedClear(websiteId);

  const range = useMemo(
    () =>
      selection.from ? toDayRange(selection.from, selection.to ?? selection.from) : undefined,
    [selection],
  );

  const preview = useQuery<ClearCounts>({
    queryKey: ['website:clear-preview', websiteId, range],
    queryFn: () => get(`/websites/${websiteId}/clear`, range),
    enabled: step === 'confirm' && !!range,
    staleTime: 0,
    gcTime: 0,
  });

  useEffect(() => {
    onBusyChange?.(batch.isBusy);
  }, [batch.isBusy, onBusyChange]);

  const formatDay = (value: number | Date) => formatDate(value, 'PP', locale);
  const formatMonth = (month?: MonthRange) =>
    month ? formatDate(month.startAt, 'LLLL yyyy', locale) : '';

  const countItems = (counts: ClearCounts) =>
    (
      [
        ['events', messages.deleteDataEvents],
        ['eventData', messages.deleteDataEventData],
        ['sessions', messages.deleteDataSessions],
        ['revenue', messages.deleteDataRevenue],
        ['replays', messages.deleteDataReplays],
      ] as const
    )
      .filter(([key]) => counts[key] > 0)
      .map(([key, message]) => <li key={key}>{t(message, { x: counts[key] })}</li>);

  const handleConfirm = () => {
    setStep('run');
    batch.start(splitRangeByMonth(range.startAt, range.endAt));
  };

  const handleDone = () => {
    if (batch.completed > 0) {
      onSave?.();
    }
    onClose?.();
  };

  if (step === 'pick') {
    return (
      <Column gap>
        <Calendar
          mode="range"
          selected={selection as any}
          maxValue={new Date()}
          onSelect={(value: any) => setSelection(value ?? {})}
        />
        <Row justifyContent="end" gap>
          <Button onPress={onClose}>{t(labels.cancel)}</Button>
          <Button variant="primary" isDisabled={!range} onPress={() => setStep('confirm')}>
            {t(labels.continue)}
          </Button>
        </Row>
      </Column>
    );
  }

  if (step === 'confirm') {
    if (preview.isLoading || !preview.data) {
      return preview.error ? (
        <Column gap>
          <Text>{getErrorMessage(preview.error as Error)}</Text>
          <Row justifyContent="end">
            <Button onPress={() => setStep('pick')}>{t(labels.back)}</Button>
          </Row>
        </Column>
      ) : (
        <Loading placement="center" />
      );
    }

    const items = countItems(preview.data);

    if (!items.length) {
      return (
        <Column gap>
          <Text>{t(messages.deleteDataEmpty)}</Text>
          <Row justifyContent="end" gap>
            <Button onPress={() => setStep('pick')}>{t(labels.back)}</Button>
            <Button onPress={onClose}>{t(labels.close)}</Button>
          </Row>
        </Column>
      );
    }

    return (
      <Column gap>
        <Text>
          {t(messages.deleteDataConfirm, {
            startDate: formatDay(range.startAt),
            endDate: formatDay(selection.to ?? selection.from),
          })}
        </Text>
        <ul>{items}</ul>
        <Row>
          <Button variant="quiet" onPress={() => setStep('pick')}>
            {t(labels.back)}
          </Button>
        </Row>
        <TypeConfirmationForm
          confirmationValue={CONFIRM_VALUE}
          onConfirm={handleConfirm}
          onClose={onClose}
          buttonLabel={t(labels.delete)}
          buttonVariant="danger"
        />
      </Column>
    );
  }

  const total = batch.months.length;
  const totalsMessage = { events: batch.totals.events, sessions: batch.totals.sessions };

  return (
    <Column gap>
      <ProgressBar value={total ? (batch.completed / total) * 100 : 0} />
      {batch.isBusy && (
        <>
          <Text>
            {t(messages.deleteDataProgress, {
              month: formatMonth(batch.current),
              current: batch.completed + 1,
              total,
            })}
          </Text>
          <Text>{t(messages.deleteDataTotals, totalsMessage)}</Text>
          <Row justifyContent="end">
            <Button isDisabled={batch.status === 'stopping'} onPress={batch.stop}>
              {t(labels.stop)}
            </Button>
          </Row>
        </>
      )}
      {batch.status === 'error' && (
        <>
          <Text>{t(messages.deleteDataError, { month: formatMonth(batch.current) })}</Text>
          <Text>{getErrorMessage(batch.error)}</Text>
          <Text>{t(messages.deleteDataTotals, totalsMessage)}</Text>
          <Row justifyContent="end" gap>
            <Button onPress={handleDone}>{t(labels.close)}</Button>
            <Button variant="primary" onPress={batch.retry}>
              {t(labels.retry)}
            </Button>
          </Row>
        </>
      )}
      {batch.status === 'stopped' && (
        <>
          <Text>
            {t(messages.deleteDataStopped, {
              month: formatMonth(batch.months[batch.completed - 1]),
            })}
          </Text>
          <Text>{t(messages.deleteDataTotals, totalsMessage)}</Text>
        </>
      )}
      {batch.status === 'done' && <Text>{t(messages.deleteDataDone, totalsMessage)}</Text>}
      {(batch.status === 'stopped' || batch.status === 'done') && (
        <Row justifyContent="end">
          <Button variant="primary" onPress={handleDone}>
            {t(labels.close)}
          </Button>
        </Row>
      )}
    </Column>
  );
}
```

If `Loading` does not accept `placement`, check its props in `node_modules/@umami/react-zen/dist/index.d.ts` and use what other settings forms pass. If `Calendar` in `range` mode needs a `numberOfMonths` prop to fit in the 400 px dialog, keep the default of one month.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run "src/app/(main)/websites/[websiteId]/settings/WebsiteClearDataForm.test.tsx"`
Expected: PASS, 4 tests. If the progress bar has no `progressbar` role, inspect the rendered DOM with `screen.debug()` and query by the role it exposes.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(main)/websites/[websiteId]/settings/WebsiteClearDataForm.tsx" "src/app/(main)/websites/[websiteId]/settings/WebsiteClearDataForm.test.tsx"
git commit -m "feat: add form to preview and delete website data for a date range"
```

---

### Task 7: Wire the form into the Data panel

**Files:**
- Modify: `src/app/(main)/websites/[websiteId]/settings/WebsiteData.tsx`
- Create: `src/app/(main)/websites/[websiteId]/settings/WebsiteData.test.tsx`

**Interfaces:**
- Consumes: `WebsiteClearDataForm` (Task 6); `labels.deleteData`, `messages.deleteDataWarning` (Task 4); `DialogTrigger` `isOpen`/`onOpenChange` from `@umami/react-zen`.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import { WebsiteData } from './WebsiteData';

const keys = new Proxy({}, { get: (_, key) => String(key) });

vi.mock('@/components/hooks', () => ({
  useLoginQuery: () => ({ user: { id: 'user-1' } }),
  useMessages: () => ({ t: (value: string) => value, labels: keys, messages: keys }),
  useModified: () => ({ touch: vi.fn() }),
  useNavigation: () => ({
    router: { push: vi.fn() },
    pathname: '/websites/website-1/settings',
    teamId: undefined,
    renderUrl: (url: string) => url,
  }),
  useUserTeamsQuery: () => ({ data: { data: [] } }),
}));

vi.mock('./WebsiteTransferForm', () => ({ WebsiteTransferForm: () => null }));
vi.mock('./WebsiteResetForm', () => ({ WebsiteResetForm: () => null }));
vi.mock('./WebsiteDeleteForm', () => ({ WebsiteDeleteForm: () => null }));
vi.mock('./WebsiteClearDataForm', () => ({
  WebsiteClearDataForm: ({ onBusyChange }: { onBusyChange: (busy: boolean) => void }) => (
    <div>
      <button type="button" onClick={() => onBusyChange(true)}>
        busy
      </button>
      <button type="button" onClick={() => onBusyChange(false)}>
        idle
      </button>
    </div>
  ),
}));

describe('WebsiteData', () => {
  test('keeps the delete data dialog open while a delete runs', async () => {
    const { user } = render(<WebsiteData websiteId="website-1" />);

    await user.click(screen.getByRole('button', { name: 'deleteData' }));
    await user.click(await screen.findByRole('button', { name: 'busy' }));
    await user.keyboard('{Escape}');

    expect(screen.getByRole('button', { name: 'busy' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'idle' }));
    await user.keyboard('{Escape}');

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'busy' })).not.toBeInTheDocument(),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run "src/app/(main)/websites/[websiteId]/settings/WebsiteData.test.tsx"`
Expected: FAIL, no button named `deleteData`.

- [ ] **Step 3: Write the implementation**

In `WebsiteData.tsx`:

Add imports:

```tsx
import { useState } from 'react';
import { WebsiteClearDataForm } from './WebsiteClearDataForm';
```

Inside the component, after `const isAdmin = ...`:

```tsx
  const [isClearOpen, setIsClearOpen] = useState(false);
  const [isClearBusy, setIsClearBusy] = useState(false);

  const handleClearOpenChange = (open: boolean) => {
    // A running delete must finish or stop before the dialog can close.
    if (!open && isClearBusy) {
      return;
    }
    setIsClearOpen(open);
  };
```

Between the reset `ActionForm` and the delete `ActionForm`:

```tsx
      <ActionForm label={t(labels.deleteData)} description={t(messages.deleteDataWarning)}>
        <DialogTrigger isOpen={isClearOpen} onOpenChange={handleClearOpenChange}>
          <Button>{t(labels.deleteData)}</Button>
          <Modal>
            <Dialog title={t(labels.deleteData)} style={{ width: 400 }}>
              {({ close }) => (
                <WebsiteClearDataForm
                  websiteId={websiteId}
                  onSave={handleReset}
                  onClose={close}
                  onBusyChange={setIsClearBusy}
                />
              )}
            </Dialog>
          </Modal>
        </DialogTrigger>
      </ActionForm>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run "src/app/(main)/websites/[websiteId]/settings/"`
Expected: PASS for `WebsiteData.test.tsx` and the other settings tests. If Escape closes the dialog without calling `onOpenChange`, read `DialogTrigger` in `node_modules/@umami/react-zen/dist/index.mjs` to find the dismiss prop it forwards, and use that instead.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(main)/websites/[websiteId]/settings/WebsiteData.tsx" "src/app/(main)/websites/[websiteId]/settings/WebsiteData.test.tsx"
git commit -m "feat: add delete data action to website settings"
```

---

### Task 8: Real-database API test and full verification

**Files:**
- Create: `tests/api/website-clear.spec.ts`

**Interfaces:**
- Consumes: the API from Task 2; fixtures `admin`, `api`, `user`, `seed` from `tests/api/fixtures.ts`; `createWebsite`, `deleteWebsite` from `tests/api/helpers/entities.ts`; `PERSONAS` from `tests/api/seed/dataset.ts`; `/api/send` with `timestamp` in seconds.

- [ ] **Step 1: Write the test**

```ts
import { expect, test } from './fixtures';
import { createWebsite, deleteWebsite } from './helpers/entities';
import { PERSONAS } from './seed/dataset';

// All events sit in July 2026, so each visitor keeps one session (the session salt rotates monthly).
const at = (day: number, hour = 12) => Date.UTC(2026, 6, day, hour);

test.describe('Clear website data for a date range', () => {
  test.describe.configure({ mode: 'serial' });

  let websiteId = '';

  test.beforeAll(async ({ admin, api, seed }) => {
    test.skip(seed.db === 'clickhouse', 'Range delete requires relational storage');

    websiteId = (await createWebsite(admin)).id;

    // spanning: Jul 10 + Jul 11, all inside the range, deleted only by the second batch.
    // crossing: Jul 9 + Jul 10, crosses the range start, so it is kept.
    // outside: Jul 12 only, kept.
    const visits = [
      { ip: '10.0.20.1', persona: PERSONAS[0], times: [at(10), at(11)] },
      { ip: '10.0.20.2', persona: PERSONAS[1], times: [at(9), at(10)] },
      { ip: '10.0.20.3', persona: PERSONAS[0], times: [at(12)] },
    ];

    for (const { ip, persona, times } of visits) {
      for (const time of times) {
        const sent = await api.post('/api/send', {
          type: 'event',
          payload: {
            website: websiteId,
            hostname: 'x.test',
            url: '/',
            ip,
            userAgent: persona.userAgent,
            timestamp: Math.floor(time / 1000),
          },
        });

        expect(sent.status).toBe(200);
      }
    }
  });

  test.afterAll(async ({ admin }) => {
    if (websiteId) {
      await deleteWebsite(admin, websiteId);
    }
  });

  test('rejects anonymous, unauthorized and invalid requests', async ({ api, user, admin }) => {
    const path = `/api/websites/${websiteId}/clear`;
    const params = { startAt: at(10, 0), endAt: at(12, 0) };

    expect((await api.get(path, { params })).status).toBe(401);
    expect((await user.get(path, { params })).status).toBe(401);
    expect((await user.post(path, params)).status).toBe(401);
    expect(
      (await admin.get(path, { params: { startAt: params.endAt, endAt: params.startAt } })).status,
    ).toBe(400);
  });

  test('preview counts match the batched delete, and data outside the range is kept', async ({
    admin,
  }) => {
    const path = `/api/websites/${websiteId}/clear`;
    const july10 = at(10, 0);
    const july11 = at(11, 0);
    const july12 = at(12, 0);

    const preview = await admin.get(path, { params: { startAt: july10, endAt: july12 } });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ events: 3, sessions: 1 });

    const first = await admin.post(path, { startAt: july10, endAt: july11 });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ events: 2, sessions: 0 });

    const second = await admin.post(path, { startAt: july11, endAt: july12 });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ events: 1, sessions: 1 });

    const remaining = await admin.get(path, {
      params: { startAt: Date.UTC(2026, 6, 1), endAt: Date.UTC(2026, 7, 1) },
    });
    expect(remaining.body).toMatchObject({ events: 2, sessions: 2 });

    const again = await admin.get(path, { params: { startAt: july10, endAt: july12 } });
    expect(again.body).toEqual({ events: 0, eventData: 0, sessions: 0, revenue: 0, replays: 0 });
  });
});

test('returns 400 on ClickHouse storage', async ({ admin, seed }) => {
  test.skip(seed.db !== 'clickhouse', 'ClickHouse only');

  const response = await admin.get(`/api/websites/${seed.website.id}/clear`, {
    params: { startAt: Date.UTC(2026, 6, 1), endAt: Date.UTC(2026, 7, 1) },
  });

  expect(response.status).toBe(400);
});
```

Check that `ApiClient.post(path, body)` and `ApiClient.get(path, { params })` match `tests/api/client.ts`, and fix the calls if the signatures differ.

- [ ] **Step 2: Run the API test against PostgreSQL**

Run: `pnpm test:api -- tests/api/website-clear.spec.ts`
Expected: the Docker stack starts, the 2 relational tests pass, and the ClickHouse test is skipped. If a SQL statement fails, the server log shows the Postgres error; fix the query in `src/queries/prisma/websiteDataRange.ts`, rerun the Task 1 unit tests, then rerun this step.

- [ ] **Step 3: Run the full verification**

Run each and confirm it exits 0:

```bash
COREPACK_ENABLE_STRICT=0 npx pnpm@12.3.4 test
COREPACK_ENABLE_STRICT=0 npx pnpm@12.3.4 lint
npx tsc --noEmit -p tsconfig.json
COREPACK_ENABLE_STRICT=0 npx pnpm@12.3.4 openapi:check
COREPACK_ENABLE_STRICT=0 npx pnpm@12.3.4 check:messages
```

Expected: all Vitest tests pass, no Biome errors, no type errors in the new files, OpenAPI up to date, 0 missing messages.

- [ ] **Step 4: Check the UI in the browser**

Start the app (`pnpm dev` with a PostgreSQL `DATABASE_URL`), open a website's Settings, Data panel, and run the flow once: pick a range of two months, check the preview counts, type `DELETE`, watch the progress label change month by month, then close. Press Escape during the run and confirm the dialog stays open.

- [ ] **Step 5: Commit**

```bash
git add tests/api/website-clear.spec.ts
git commit -m "test: add API test for deleting website data by date range"
```
