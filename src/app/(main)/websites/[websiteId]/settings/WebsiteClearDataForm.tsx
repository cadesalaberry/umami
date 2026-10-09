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
    if (!range) {
      return;
    }
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
            startDate: formatDay(range!.startAt),
            endDate: formatDay((selection.to ?? selection.from)!),
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
