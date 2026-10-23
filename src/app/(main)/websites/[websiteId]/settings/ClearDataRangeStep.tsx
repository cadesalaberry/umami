import {
  Button,
  Column,
  DatePicker,
  ListItem,
  Select,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Text,
} from '@umami/react-zen';
import { useLocale, useMessages } from '@/components/hooks';
import { formatDate } from '@/lib/date';
import { ClearDataFrame } from './ClearDataFrame';
import { OLDER_THAN_MONTHS, type Period, updatePeriod } from './clearDataHelpers';

export type ClearDataMode = 'olderThan' | 'period';

export function ClearDataRangeStep({
  mode,
  months,
  period,
  cutoff,
  today,
  canContinue,
  onModeChange,
  onMonthsChange,
  onPeriodChange,
  onContinue,
  onCancel,
}: {
  mode: ClearDataMode;
  months: number;
  period: Period;
  cutoff: Date;
  today: Date;
  canContinue: boolean;
  onModeChange: (mode: ClearDataMode) => void;
  onMonthsChange: (months: number) => void;
  onPeriodChange: (period: Period) => void;
  onContinue: () => void;
  onCancel?: () => void;
}) {
  const { t, labels, messages } = useMessages();
  const { locale } = useLocale();

  const handleDateChange = (field: keyof Period) => (value: Date | undefined) => {
    if (value) {
      onPeriodChange(updatePeriod(period, field, value));
    }
  };

  return (
    <ClearDataFrame
      actions={
        <>
          <Button onPress={onCancel}>{t(labels.cancel)}</Button>
          <Button variant="primary" isDisabled={!canContinue} onPress={onContinue}>
            {t(labels.continue)}
          </Button>
        </>
      }
    >
      <Tabs selectedKey={mode} onSelectionChange={key => onModeChange(key as ClearDataMode)}>
        <TabList>
          <Tab id="olderThan">{t(labels.olderThan)}</Tab>
          <Tab id="period">{t(labels.period)}</Tab>
        </TabList>
        <TabPanel id="olderThan">
          <Column gap paddingTop="4">
            <Select
              value={String(months)}
              onChange={value => onMonthsChange(Number(value))}
              triggerProps={{ 'aria-label': t(labels.olderThan) }}
            >
              {OLDER_THAN_MONTHS.map(value => (
                <ListItem key={value} id={String(value)}>
                  {t(labels.xMonths, { x: value })}
                </ListItem>
              ))}
            </Select>
            <Text color="muted">
              {t(messages.deleteDataOlderThan, { date: formatDate(cutoff, 'PP', locale) })}
            </Text>
          </Column>
        </TabPanel>
        <TabPanel id="period">
          <Column gap paddingTop="4">
            <DatePicker
              label={t(labels.from)}
              value={period.from}
              maxValue={today}
              locale={locale}
              onChange={handleDateChange('from')}
            />
            <DatePicker
              label={t(labels.to)}
              value={period.to}
              minValue={period.from}
              maxValue={today}
              locale={locale}
              onChange={handleDateChange('to')}
            />
          </Column>
        </TabPanel>
      </Tabs>
    </ClearDataFrame>
  );
}
