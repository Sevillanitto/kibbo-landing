# US Airline Reliability Dataset (2026 H1)

**Files:** `us-airline-ranking-2026-h1.csv`, `us-airline-ranking-2026-h1-yoy-comparison.csv`, `us-airline-ranking-2026-h1-spirit-monthly.csv`
**9 major US airlines · January–June 2026**

## What this is

An extract from the US Department of Transportation's own published
reliability figures for the 9 major US airlines, covering the first half
of 2026, built for Kibbo's investigation ranking which airline performed
worst on four consumer-facing reliability metrics.

This dataset was originally shipped as a single CSV stacking three
separate tables, which breaks a clean import into Excel, Google Sheets,
or pandas. It has since been split into three files, one table each,
listed below.

## Files and columns

### `us-airline-ranking-2026-h1.csv` — main ranking

| Column | Description |
|---|---|
| `rank` | 1 (best) to 9 (worst), by `composite_score`. Tied scores share a rank (e.g. two airlines at rank 2) |
| `airline` | Airline name |
| `on_time_pct` | Percentage of flights arriving on time, H1 2026 |
| `cancelled_pct` | Percentage of flights cancelled, H1 2026 |
| `baggage_mishandled_per_100` | Mishandled-baggage reports per 100 passengers, H1 2026 |
| `bumped_per_10000` | Involuntary denied-boarding ("bumping") rate per 10,000 passengers, H1 2026 |
| `composite_score` | See "Composite score methodology" below |

### `us-airline-ranking-2026-h1-yoy-comparison.csv` — year-over-year

| Column | Description |
|---|---|
| `airline` | Airline name |
| `cancelled_pct_h1_2025` / `cancelled_pct_h1_2026` | Cancellation rate, same airline, H1 2025 vs. H1 2026 |
| `change_points` | `cancelled_pct_h1_2026` − `cancelled_pct_h1_2025`, in percentage points |
| `change_relative_pct` | That same change, as a percentage of the 2025 figure |
| `on_time_pct_h1_2025` / `on_time_pct_h1_2026` | On-time rate, H1 2025 vs. H1 2026 |
| `on_time_change_points` | `on_time_pct_h1_2026` − `on_time_pct_h1_2025`, in percentage points |

### `us-airline-ranking-2026-h1-spirit-monthly.csv` — Spirit's monthly on-time rate

Spirit Airlines ceased operations on May 2, 2026. This table breaks its
H1 on-time rate down by month against the industry average, since the
H1-wide figure in the main table obscures how much it declined right
before shutting down.

| Column | Description |
|---|---|
| `month` | January–May 2026 |
| `spirit_on_time_pct` | Spirit's on-time percentage that month |
| `industry_average_pct` | The 9-airline industry average that month |

## Source

US Department of Transportation, *Air Travel Consumer Report*, August
2026 edition — Table 1B (on-time performance), Table 1C (mishandled
baggage and cancellations), and Table 6B (involuntary denied boarding).

## Composite score methodology

Each airline is ranked 1st (best) through 9th (worst) separately on
`on_time_pct`, `cancelled_pct`, `baggage_mishandled_per_100`, and
`bumped_per_10000`. The four ranks are averaged, unweighted, to produce
`composite_score` — a lower score is a better overall record. This
matches the methodology stated in the investigation itself.

**Reproducing this from the CSV exactly requires one extra fact not
visible in the rounded data.** Three of the four metrics have no tied
values among these 9 airlines, so ranking them from the published
figures is unambiguous. `bumped_per_10000` does have two ties at this
rounding (Allegiant and Delta both show `0.00`; Southwest and United
both show `0.01`). The unrounded values that were used when the
original ranking was built were not retained, so those ties can't be
broken from source data.

**The order below is a reconstruction, not the original method.** We
worked backward from the 9 published `composite_score` values to find
a bumping order that reproduces all of them exactly, and this is the
one that does:

**Bumping rank, best to worst:** Delta → Allegiant → United → Southwest
→ JetBlue → Alaska → American → Spirit → Frontier.

Use that order (rather than the tied `0.00`/`0.01` values) when ranking
`bumped_per_10000` if you need to reproduce `composite_score` exactly —
it is confirmed to match all 9 published scores with no rounding error,
but it was derived after the fact, not sourced from DOT's underlying
figures.

## Limitations

- The composite score weights all four metrics equally. An airline that
  is merely average on three metrics and best-in-class on one will
  outrank an airline that is good across the board but never
  best — see the investigation's own discussion of Allegiant's #1
  finish.
- `bumped_per_10000` in particular is a low-incidence metric where small
  absolute differences (a handful of passengers) can swing a rank —
  see "Composite score methodology" above.
- Spirit Airlines ceased operations during the measurement period
  (May 2, 2026); its H1 figures reflect only the months it operated.
- This is a single six-month snapshot (H1 2026), not a multi-year trend,
  except where the year-over-year file provides H1 2025 for comparison.

## Citation

If you use this dataset, please credit "Kibbo (getkibbo.com)" and link
back to the investigation it was built for.

Last updated: October 2026.
