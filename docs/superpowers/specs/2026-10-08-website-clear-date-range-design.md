# Delete website data for a date range

Date: 2026-10-08
Issue: https://github.com/umami-software/umami/issues/2810
Status: approved design, pending spec review

## Goal

Let a user with update permission on a website permanently delete the
analytics data recorded between two dates, without resetting the whole
website. Typical uses: remove developer test traffic or traffic anomalies
that pollute long-term statistics.

## Scope

In scope:

- Delete data for a date range, PostgreSQL deployments only.
- A preview that states how many items the delete will remove.
- A UI that deletes month by month, with a progress bar and the name of the
  month being deleted.

Out of scope:

- ClickHouse support. The API returns `400` when `isRelationalOnly()` is
  false, the same as the session delete route.
- Raw data import and export (the second half of issue #2810). This is a
  separate project.
- A server-side cap on the range size of one API call.

## Data semantics

The range is half-open: `[startAt, endAt)`, epoch milliseconds.

Event-level rows are deleted when `websiteId` matches and `createdAt` is in
the range:

- `website_event`
- `event_data` (by `websiteId` + `createdAt`, and by a raw join on the parent
  `website_event` in range, which mirrors the hardened reset in
  `deleteWebsiteDependentData`)
- `revenue`
- `heatmap_event`
- `session_replay`

Orphan sessions are sessions of the website that have at least one
`website_event` in the range and no `website_event` outside the range. For
these sessions the delete also removes `session_data`, `session_link`, and
any leftover `session_replay`, `heatmap_event` and `revenue`, then the
`session` row. Session ids go to Postgres as one `uuid[]` parameter, so a
large number of sessions does not hit the bind parameter limit.

`replays` in the counts is the number of distinct visits that have replay
chunks in the range.

`session_replay_saved` rows are deleted when their visit has no
`session_replay` chunks left.

The preview and the delete use the same predicates, so the preview counts
exactly the rows the delete removes (at the time of the preview).

Not changed: `website.resetAt`, reports, segments, annotations, shares, and
the Redis website cache.

## API

Route: `src/app/api/websites/[websiteId]/clear/route.ts`.

Both handlers:

- Validate with `parseRequest` and one zod schema: `startAt` and `endAt` are
  coerced numbers, with a refine `startAt < endAt`.
- Check `canUpdateWebsite(auth, websiteId)`, else `unauthorized()`.
- Return `badRequest()` when `!isRelationalOnly()`.

`GET /api/websites/:websiteId/clear?startAt&endAt` is the preview. It is
read-only and returns:

```json
{ "events": 0, "eventData": 0, "sessions": 0, "revenue": 0, "replays": 0 }
```

`POST /api/websites/:websiteId/clear` with body `{ "startAt", "endAt" }`
deletes the data and returns the same shape with the counts actually
deleted. These can differ from the preview when new events arrive in the
range between the two calls.

Add the new operation ids to `src/openapi/operation-ids.ts` and regenerate
the contract with `pnpm openapi:contracts`.

## Queries

In a new file `src/queries/prisma/websiteDataRange.ts`, exported from
`src/queries/prisma/index.ts`:

- `getWebsiteDataCounts(websiteId, startDate, endDate)` runs the preview
  counts.
- `clearWebsiteData(websiteId, startDate, endDate)` runs the delete in one
  `prisma.transaction` with a 30 second timeout (the same as
  `resetWebsite`), in this order:
  1. `event_data` for events in range (raw join, then `deleteMany`).
  2. `revenue`, `heatmapEvent`, `sessionReplay` in range.
  3. Collect the orphan session ids, before events are deleted.
  4. `websiteEvent` in range.
  5. For orphan sessions: `session_data`, `session_link`, leftover
     `session_replay`, `heatmap_event`, `revenue`, then `session`.
  6. `sessionReplaySaved` rows whose visit has no replay chunks left.

Raw SQL sets `search_path` from `getSchema()`, as the reset does.

## UI

Location: website Settings, Data panel
(`src/app/(main)/websites/[websiteId]/settings/WebsiteData.tsx`). A new
`ActionForm` sits between Reset and Delete. Its button opens a modal with
`WebsiteClearDataForm.tsx`, which has four steps:

1. Pick range. Two `Calendar` components from `@umami/react-zen`, with the
   same layout as `DatePickerForm`. The range is `startOfDay(start)` to
   `endOfDay(end)` in the browser timezone. The maximum date is today.
   "Continue" is disabled when the start is after the end.
2. Confirm. The form calls the preview `GET` and shows a spinner while it
   loads. It then lists the non-zero counts and the formatted dates, for
   example "This will permanently delete 12,345 events and 1,203 sessions
   between Oct 1, 2026 and Oct 3, 2026". The user types `DELETE` in
   `TypeConfirmationForm` (`buttonVariant="danger"`). A "Back" button
   returns to step 1. When all counts are zero, the form shows "No data
   found in this date range" and no confirmation field.
3. Delete with progress. See "Batching" below.
4. Done. A summary with the actual totals and a "Close" button. On close
   the form calls `touch` for the website queries so the dashboard
   refetches.

When the API returns `400` on a ClickHouse deployment, the form shows the
error. No new client flag is added.

### Batching

The client splits the range into calendar months in the browser timezone,
with the first and last months clipped to the range. Example: Sep 15 to
Nov 10 gives Sep 15–30, Oct 1–31 and Nov 1–10. A pure helper does the split
so it can be unit tested.

The client calls `POST /clear` once per month, in ascending order, one call
at a time. Each call is its own transaction, so a failure never leaves a
month half deleted, and each transaction stays small.

Ascending order keeps orphan sessions correct. A session with events on
Sep 30 and Oct 1 is kept by the September batch, because it still has
October events, and is deleted by the October batch. The sum of deleted
sessions equals the preview count.

Progress display:

- `ProgressBar` from `@umami/react-zen`, value = completed months / total
  months.
- Label: "Deleting October 2026 (2 of 3)".
- Running totals under the bar: "8,120 events, 640 sessions deleted".
- The dialog cannot be dismissed while a batch runs. A `beforeunload`
  handler warns the user if they leave the page.
- "Stop" finishes the current month, then stops and shows the done step
  with the partial totals.
- On error the form stops, shows the failed month and the months already
  deleted, and offers "Retry", which resumes from the failed month.

## Translations

Add the new keys to `src/components/messages.ts`: a label for the action,
"Continue" and "Back" if they do not exist, and messages for the warning,
the preview summary, no data, the progress label, the running totals, the
error and the done summary. Add the keys to all
`public/intl/messages/*.json` files, with English text in the non-English
files, as commit `3e729bc0e` did. Check with `pnpm check:messages`.

## Testing

Vitest unit tests:

- `src/queries/prisma/website.test.ts`: with a fake `tx`, assert the delete
  order, the range `where` on each table, the orphan session predicate, and
  the returned counts. Assert the preview uses the same predicates.
- `src/app/api/websites/[websiteId]/clear/route.test.ts`: invalid range
  gives `400`, ClickHouse gives `400`, no permission gives `401`, `GET`
  returns counts, `POST` calls the delete and returns counts.
- Month split helper: month boundaries, timezone, a single-day range, a
  range inside one month, a range across a year boundary.
- `WebsiteClearDataForm.test.tsx`: zero counts hide the confirmation,
  counts are rendered, the confirm needs `DELETE`, the progress label
  advances per month, "Stop" stops after the current month, "Retry"
  resumes from the failed month.

Playwright API spec in `tests/api/`: seed events over three days, clear the
middle day, and assert that the other days are intact and that sessions
spanning the boundary are kept. Run with `pnpm test:api` when Docker is
available.

Also run `pnpm openapi:check`, the Biome lint and `tsc`.

## Risks

- A single API call with a very large range can exceed the 30 second
  transaction timeout. The UI avoids this by batching by month. API callers
  must batch themselves.
- A very busy month can still be slow. If tests show timeouts, raise the
  timeout for this transaction only.
- If the user closes the tab during the delete, the remaining months are
  not deleted. Deleted months stay deleted and the data stays consistent.
