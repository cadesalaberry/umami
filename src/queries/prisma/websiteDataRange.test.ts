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
  orphanVisitIds = [] as string[],
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
        if (sql.includes('candidate.session_id')) return [{ count: counts.sessions ?? 0 }];
        if (sql.includes('session_replay.visit_id')) return [{ count: counts.replays ?? 0 }];
      }
      if (sql.includes('candidate.session_id')) {
        calls.push('selectSessions');
        return sessionIds.map(id => ({ id }));
      }
      if (sql.includes('any($2::uuid[])') && sql.includes('session_replay.visit_id')) {
        calls.push('selectOrphanVisits');
        return orphanVisitIds.map(id => ({ id }));
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
      if (table === 'event_data') return sql.includes(' using ') ? 3 : 4;
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
      'selectOrphanVisits',
      'raw:event_data',
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

    expect(tx.calls).not.toContain('selectOrphanVisits');
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
      'website_event.created_at < $2 or website_event.created_at >= $3 or website_event.created_at is null',
    );
    expect(params).toEqual([websiteId, startDate, endDate]);
  });

  test('deletes event data with two indexed statements and sums their counts', async () => {
    const tx = createTx();
    transactionMock.mockImplementation(async cb => cb(tx));

    const result = await clearWebsiteData(websiteId, startDate, endDate);

    const deletes = tx.$executeRawUnsafe.mock.calls.filter(([sql]) =>
      sql.startsWith('delete from event_data'),
    );
    expect(deletes).toHaveLength(2);
    expect(deletes[0][0]).toContain('website_id = $1::uuid');
    expect(deletes[0][0]).not.toContain('select');
    expect(deletes[1][0]).toContain('using website_event');
    expect(deletes[1][0]).toContain('event_data.website_event_id = website_event.event_id');
    expect(deletes.map(([, ...params]) => params)).toEqual([
      [websiteId, startDate, endDate],
      [websiteId, startDate, endDate],
    ]);
    expect(result.eventData).toBe(7);
  });

  test('orphan sessions are driven from events in range', async () => {
    const tx = createTx();
    transactionMock.mockImplementation(async cb => cb(tx));

    await clearWebsiteData(websiteId, startDate, endDate);

    const [orphanSql] = tx.$queryRawUnsafe.mock.calls[0];
    expect(orphanSql).toContain('select distinct website_event.session_id from website_event');
    expect(orphanSql).not.toContain('from session ');
  });

  test('cleans saved replays of orphan sessions whose chunks sit outside the range', async () => {
    const tx = createTx({
      sessionIds: ['s1'],
      visitIds: ['v1', 'v2'],
      orphanVisitIds: ['v2', 'v3'],
    });
    transactionMock.mockImplementation(async cb => cb(tx));

    const result = await clearWebsiteData(websiteId, startDate, endDate);

    const savedDelete = tx.$executeRawUnsafe.mock.calls.find(([sql]) =>
      sql.startsWith('delete from session_replay_saved'),
    );
    expect(savedDelete?.[2]).toEqual(['v1', 'v2', 'v3']);
    expect(result.replays).toBe(2);
    const orphanVisits = tx.$queryRawUnsafe.mock.calls.find(([sql]) =>
      sql.includes('any($2::uuid[])'),
    );
    expect(orphanVisits?.slice(1)).toEqual([websiteId, ['s1']]);
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
    const eventDataDeletes = clearTx.$executeRawUnsafe.mock.calls
      .map(([sql]) => sql)
      .filter(sql => sql.startsWith('delete from event_data'));

    expect(previewSql).toContain(orphanSql);
    expect(eventDataDeletes).toHaveLength(2);
    expect(previewSql).toContain(eventDataDeletes[0].replace('delete from event_data where ', ''));
    expect(previewSql).toContain(
      eventDataDeletes[1].replace('delete from event_data using website_event where ', ''),
    );
  });

  test('previews event data as the union of both delete statements', async () => {
    const tx = createTx();
    transactionMock.mockImplementation(async cb => cb(tx));

    await getWebsiteDataCounts(websiteId, startDate, endDate);

    const sql = tx.$queryRawUnsafe.mock.calls.map(([s]) => s).find(s => s.includes('event_data_id'));
    expect(sql).toContain('union');
    expect(sql).toContain('event_data.website_event_id = website_event.event_id');
  });
});
