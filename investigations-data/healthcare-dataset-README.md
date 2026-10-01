# Kibbo Healthcare Cost Dataset (2026)

**File:** `kibbo-healthcare-cost-dataset-2026.csv`
**58 rows · 4 countries · 4 tracer treatments · 3 cost layers + wait times**

## What this is

An original dataset built by Kibbo comparing the real cost of getting sick
in four countries — the United States, United Kingdom, Germany, and
Spain — chosen to represent four genuinely different healthcare
financing models (private-insurance-led, pure public/NHS, mandatory
social insurance, and public/mandatory-mixed).

This is not a reproduction of OECD or WHO summary statistics. Every
figure was independently verified against a primary source — government
data, an official regulator publication, or a peer-reviewed
international cost-comparison study — and cross-checked before
inclusion.

## Why three cost layers

A single number for "the cost of healthcare" hides more than it reveals,
because what counts as a cost differs by system:

- **Layer A** — what you pay in advance, every year, whether you get
  sick or not: an insurance premium, a payroll contribution, or a share
  of general taxation.
- **Layer B** — what a specific treatment actually costs at the moment
  you receive it, broken out where possible into the listed/billed
  charge and the negotiated/cash price.
- **Layer C** — the cost of optional supplementary private insurance,
  shown separately and never treated as a country's base case.

**Total real cost = Layer A + Layer B (+ Layer C where relevant).**

## The four tracer treatments

Appendectomy (uncomplicated), hip replacement (uncomplicated), knee MRI
(no contrast), and vaginal delivery (uncomplicated) — chosen because
each is a standardized, comparable procedure across health systems, the
same reasoning that makes these "tracer procedures" a recognized
approach in comparative health economics. Cancer treatment was
deliberately excluded: its cost and course vary too much to compare
rigorously using this method.

## An important, deliberate gap — and why it's in the data, not hidden

For the United Kingdom, Germany, and Spain, we could not verify a
current, per-treatment breakdown of what the **public system itself**
pays internally for these treatments (our Layer B for those three
countries). The reason differs by country — the NHS stopped publishing
detailed per-treatment Reference Costs around 2019/20; Germany's DRG
relative weights for these specific procedures aren't published in an
easily verifiable public form; Spain's Ministry of Health does not
publish a comparable per-treatment cost breakdown for the public system.

**We did not fill this gap with an estimate.** Every affected row is
marked `DATA GAP` in the `source` column, with `value` left blank. We
treat this opacity itself as a finding: it's far easier to find out what
a hospital bills an insured American for an appendectomy than what
Spain's or Germany's public system actually spends on the same
procedure — and that asymmetry is worth knowing on its own.

Where we did find data — for private/supplementary insurance pricing
across all four countries (Layer C), via the same international claims
report — we used it, and note explicitly that this represents private
insurance pricing, not the public system's internal cost, for the UK,
Germany, and Spain.

## Wait times: two different things, not directly comparable

The US and Germany measure and publish **time to a specialist
appointment**. The UK and Spain measure and publish **time to actual
treatment** (referral-to-treatment). These are genuinely different
points in the care pathway. Every wait-time row states which one it
is — comparing the raw numbers across that boundary without this
distinction would be misleading, and we explicitly flag it in every
affected row.

## Methodology notes

- **Reference year:** most recent available (2024–2026 depending on the
  metric and source's own publication cycle).
- **Standard population:** adult, no complex pre-existing conditions.
- **Standard profile per country:** US = employer-sponsored insurance;
  UK = standard NHS, no private top-up; Germany = statutory GKV; Spain =
  public Seguridad Social.
- **Source hierarchy used:** government/regulator official data →
  international body with public methodology → peer-reviewed academic
  study → investigative journalism with cited primary sources. Never
  blogs or commercial insurance-comparison sites.
- Every note in the `notes` column marking an asterisked limitation in
  the investigation's own article corresponds to the `notes` field of
  the relevant row here.

## Citation

If you use this dataset, please credit "Kibbo (getkibbo.com)" and link
back to the investigation it was built for.

Last updated: October 2026.
