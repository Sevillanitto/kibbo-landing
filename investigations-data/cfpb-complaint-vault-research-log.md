# Research log — The CFPB Complaint Vault

Kibbo Research · open research project · started 3 October 2026
Every analytical decision is recorded here with its date, what was decided, why, and what was rejected. Scripts live in `scripts/`; outputs in `analysis/stepN/`.

---

## Step 1 — Data inventory (2026-10-03)

**Downloaded**
- Main database: files.consumerfinance.gov/ccdb/complaints.csv.zip, via consumerfinance.gov/data-research/consumer-complaints/. 18,167,713 complaints, 2011-12-01 to 2026-10-03.
- Narratives Archive: 21 CSV files from the CFPB FOIA Electronic Reading Room (complaints received 2011-12-01 to 2026-08-14). 17,533,918 rows, 3,851,415 with a narrative. Earliest narrative: 2015-03-19.

**Findings that changed the plan**
- The main database no longer contains `Consumer complaint narrative`, `Consumer consent provided?` or `Consumer disputed?`. Narratives exist only in the archive. Plans to compare narrative coverage between the two files, or to use the "disputed" field, were dropped.
- Archive-to-main join by Complaint ID: 99.88% match on a 5,000-ID random sample. Judged sufficient.
- Product taxonomy changed twice: April 2017 and August 2023 (initial assumption was one change). Issue taxonomy also changed.
- Credit reporting share of complaints: 20.4% (2015) → 91.1% (2026).

## Step 2 — Cross-tabulations (2026-10-03)

**Decision: harmonise products into 11 product families** (mapping in `tables/product-taxonomy-crosswalk.csv`). All 21 product names mapped; none left over. Issues are NOT harmonised — compared only within one taxonomy period.

**Decision: treat credit reporting separately.** It is 88% of 2025 complaints and would dominate every aggregate.

**Finding:** the 2025 money-transfer jump (16,800 → 84,600) is concentrated in one week of January 2025, under the issue "Other transaction problem" (42,521 that month vs ~200–300/month in 2024), mainly Block, Inc. and Early Warning Services, LLC.

**Decision: company fingerprints use only complaints from 2023-08-25 onwards**, so the issue taxonomy is consistent.

## Step 3 — Narrative samples (2026-10-03)

- Fixed seed 42 for all samples. A sampling bug (DuckDB `USING SAMPLE` applied before `WHERE`) produced near-empty samples on the first run; fixed by filtering in a subquery first, then sampling. All samples re-run.
- January 2025 window (2025-01-14 to 2025-01-21): 61.6% of Block narratives and 55.9% of Early Warning Services narratives were exact duplicates of another narrative.
- Template (near-)duplicate share rose sharply in credit reporting and debt collection. This became the central question of the investigation.
- **Decision: frame the January 2025 spike as previously reported.** Consumer Reports reported it first (2025), linking it to social-media influencers. Kibbo's contribution is measurement (daily curve, duplicate share), not discovery. Influencers are not named by Kibbo; attribution goes to Consumer Reports' reporting.
- **Monetary relief check:** excluding the January spike, 2025 monetary relief outside credit reporting was 4.2% (vs ~8% in 2023), so the spike does not explain the decline.

## Step 4 — Template detection across all narratives (2026-10-03)

**Method**
1. Exact duplicate (identical raw text).
2. Normalised duplicate (lowercase; remove XXXX, numbers, punctuation; collapse whitespace).
3. Fuzzy: MinHash/LSH, word 5-shingles, 128 permutations, Jaccard ≥ 0.8; narratives < 30 words skipped (366,346; 9.51%).

**Engineering decisions (memory limits on a 13.8 GB machine)**
- In-memory design failed. Rebuilt with on-disk DuckDB, hash-only storage for levels 1–2, MinHash run once per distinct normalised text, LSH banding in DuckDB, union-find clustering, one process per year, resumable.
- **Fuzzy clusters are built within each calendar year.** 2025 failed three times even at 1 GB DuckDB limit and was split into H1/H2 for the fuzzy level only (levels 1–2 stay global). 92,906 of 2025's narratives (7.6%) are flagged by the fuzzy level only and are the ones potentially affected. Effect: 2025 fuzzy figures are a slight lower bound.
- Rejected: splitting years into months (would break templates spanning months).

**Validation**
- 100 fuzzy-only pairs reviewed by hand: genuinely near-identical text.
- 50 pairs at Jaccard 0.6–0.8 (below threshold): mostly the same template with more edits → **threshold is conservative; figures are lower bounds**.
- Issue found: 16% of fuzzy-only pairs were filed the same day against different companies — likely one person, not a shared template. Led to step 5.

**Result:** 57.6% of all narratives (2015–2026) match at least one other narrative at some level.

## Step 5 / 5b — Shared templates vs one person filing several times

- CFPB does not publish filer identity. First rule (step 5): same text + same date + same state + same ZIP = same filer.
- Hand check (30 pairs) found 14 "shared" pairs from the same ZIP on different days → likely one person re-filing. **Decision (5b): strict rule by location** — a text group is `shared_template_strict` only if it spans ≥ 2 distinct locations (ZIP, or state when ZIP is missing/masked). Same-location groups → `same_filer_repeat`.
- Second hand check (30 strict pairs): none shared a ZIP; 20 were in different states; 3 shared the same 3-digit ZIP prefix (possible same person, due to CFPB ZIP truncation). Accepted and documented as a small margin of error.
- Upper and lower bounds are close: only 57,194 narratives moved between categories. Strict rule adopted for all published figures.
- **Overall (2015–2026):** original 42.4%, shared_template_strict 36.1%, same_filer_repeat 21.4%, unknown 0.1%.
- **Outcomes within the same issue (2022–2025):** templates rarely get monetary relief (e.g. bank accounts, "Problem caused by your funds being low": 18.6% original vs 0.3% template) but more often get non-monetary relief (e.g. credit reporting "Incorrect information on your report": 35% vs 51%). Reported as correlation, not causation.

## Step 6 — Controlled company comparisons, population, lists

- Census population: Vintage 2019 (2012–2019) and Vintage 2025 (2020–2025) state totals from census.gov. No estimate for 2011 or 2026.
- "Servicer under contract with Federal Student Aid" is a placeholder label, not a company; its 7,524 complaints (2024–2026) are all recorded as untimely. Not presented as a company's conduct.
- Kriya Capital: shift from "closed with explanation" (to 2019) to almost all "non-monetary relief" (2020 onwards). Not a data error; described as a change in practice.
- **Decision: company comparisons use only complaints that are not known templates** (original + no narrative), within the same product family, vs the all-industry baseline.
- **Caveat adopted everywhere:** company responses are self-reported and not verified by the CFPB.

## Step 7 / 7b / 7c / 7d — Dataset package and bank denominators

- Company classification (top 200): 119 `known`, 81 `profile` (mainly small debt collectors; not individually verified). One left unclassified (FC HoldCo).
- FDIC BankFind matching: automatic top match was wrong for JPMorgan Chase, PNC, Citizens and Synovus; corrected by exact name + active status (see `analysis/step7/fdic-selected.csv` for the CERTs used). SunTrust, BB&T, BBVA, TCF kept as merged/acquired; Discover, Comerica, Synovus noted only as "inactive per FDIC".
- **Denominator decisions (important):**
  - All complaints / deposits → rejected: penalises card-heavy banks (Capital One 67.6 vs ~9 for peers).
  - Bank-account complaints / deposits → Capital One still highest (15.7), but deposits include business and institutional money, which favours big banks with large corporate businesses.
  - **Adopted: bank-account complaints per 100,000 deposit accounts of $250,000 or less** (FDIC field DEPSMB, Call Report Schedule RC-O). With this measure Capital One drops to 4th (17.7); Citibank 22.9 vs Bank of America 8.3, JPMorgan Chase 7.4, U.S. Bank 4.3. Banks with < 300 bank-account complaints flagged `min_volume_flag`.
  - Lesson recorded: three reasonable denominators gave three different rankings. The published figure must state its denominator.
- Package v1.0 built: complaint-level file (CSV.gz + Parquet by year), 12 tables, data dictionary, README, scripts, requirements, SHA-256 checksums. Narrative text and filer keys excluded.

## Corrections to our own working notes

- In an internal working summary, the largest template cluster was described as spanning "4,952 locations". The package table shows 2,588 distinct locations (cluster Y2024-1, 34,309 narratives). The figure of ~4,800–4,950 referred to distinct filer keys (date + ZIP), a different measure. Published figure: 2,588 locations.

## Open items

- Requests for comment to companies named in the article (before publication).
- Zenodo deposit and DOI; fill README placeholders (DOI, article link, contact).
- Quarterly link and data review; re-run with future CFPB releases → dataset v1.1.
