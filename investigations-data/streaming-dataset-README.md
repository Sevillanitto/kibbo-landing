# Kibbo Streaming Pricing Dataset (2011–2026)

**File:** `kibbo-streaming-pricing-dataset-2011-2026.csv`
**97 rows · 10 platforms · US pricing only**

## What this is

An original dataset built by Kibbo, tracking every publicly confirmed price
change (launch, increase, decrease, or tier restructure) for 10 major US
streaming platforms from each platform's launch through September 2026:

Netflix, Disney+, Hulu, Max (HBO Max), Prime Video, Peacock, Apple TV+,
Paramount+, ESPN, YouTube TV.

This is not a reproduction of any single third-party report. Every row was
independently verified against contemporaneous news coverage (Reuters,
Variety, TechCrunch, Axios, 9to5Google, and similar outlets reporting each
price change at the time it happened), then cross-checked across at least
two independent sources before being included.

## Columns

| Column | Description |
|---|---|
| `platform` | Normalized platform name (one consistent name per platform across all its rows, even across rebrands) |
| `tier_or_plan` | The specific plan/tier affected. Renamed tiers are noted in parentheses so the same underlying tier can be traced across a rebrand |
| `event_date` | Date the change took effect (YYYY-MM or YYYY-MM-DD, depending on source precision) |
| `event_type` | `launch`, `increase`, `decrease`, or `restructure` (a tier renamed/repositioned with no price change) |
| `price_before_usd` | Monthly price before the change (USD). Blank for `launch` rows |
| `price_after_usd` | Monthly price after the change (USD) |
| `percent_change` | Calculated percentage change. Blank for `launch` rows |
| `country` | Currently US-only for every row |
| `notes` | Context, data-gap flags, or relevant detail (e.g. rebrands, class-action outcomes, restructures) |
| `source_publication` | The outlet(s) whose contemporaneous reporting the row was verified against |

## Methodology

- Every increase/decrease row's `percent_change` was independently
  recalculated from `price_before_usd` and `price_after_usd` — not copied
  from any source — and checked against the source's own stated percentage
  where one was given.
- Where a platform rebranded (e.g. HBO Max → Max → HBO Max; ESPN+ → ESPN
  Select) but the underlying tier continued, the `platform` and
  `tier_or_plan` fields keep that continuity traceable rather than treating
  the rebrand as an unrelated new product.
- One confirmed data gap exists: ESPN's exact price between October 2022
  ($9.99) and the next confirmed figure (oct 2024, $10.99 base) could not be
  pinned to a specific date against a primary source, and no figure was
  invented to fill it — see the `notes` field on that row.
- Hulu (2019) is the only documented price *decrease* found across all 10
  platforms and 97 tracked events.

## Suggested uses

- Comparing cumulative price growth across platforms since each one's launch
- Identifying which platforms bundle price increases with tier
  restructures or rebrands (a recurring pattern in this dataset)
- Building a "loyal subscriber vs. new subscriber" cumulative cost
  comparison for any single platform

## Citation

If you use this dataset, please credit "Kibbo (getkibbo.com)" and link back
to the investigation it was built for.

Last updated: September 2026.
