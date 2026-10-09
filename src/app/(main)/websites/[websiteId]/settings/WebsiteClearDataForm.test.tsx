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
