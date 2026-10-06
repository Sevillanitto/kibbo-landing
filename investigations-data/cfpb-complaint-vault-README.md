# The CFPB Complaint Vault Dataset (v1.0)

**Kibbo Research** · getkibbo.com · October 2026
License: CC BY 4.0 · DOI: 10.5281/zenodo.23188842 (https://doi.org/10.5281/zenodo.23188842)

A harmonised, enriched version of all 18,167,713 complaints in the U.S. Consumer Financial Protection Bureau (CFPB) Consumer Complaint Database (December 2011 to October 2026), with original measures of copy-paste ("template") complaint narratives, a product taxonomy that is comparable across the CFPB's classification changes, company business types, and state population rates.

It was built for the Kibbo Research investigation *The Copy-Paste Complaint* (https://www.getkibbo.com/investigations/cfpb-copy-paste-complaints), and is published so that journalists, researchers, students and regulators can check, reuse and extend the analysis.

---

## What's new in this dataset

The CFPB publishes the raw records. This dataset adds:

1. **A harmonised product family.** The CFPB changed its product and issue categories in April 2017 and again in August 2023. The `product_family` field (11 families) makes complaints comparable across all years. The full mapping is in `tables/product-taxonomy-crosswalk.csv`.
2. **Template detection for every narrative.** Each of the 3.85 million published consumer narratives is checked for exact duplicates, normalised duplicates and near-duplicates (MinHash/LSH), and classified as original text, a template shared across different locations, or the same text repeated from a single location.
3. **Company business types** for the 200 companies with the most complaints, with a column stating whether each classification is based on the company's well-known public identity or only on its name and complaint profile.
4. **Complaints per 100,000 residents** by state and year, using U.S. Census Bureau population estimates.
5. **Bank complaint rates relative to deposits and to total assets**, using FDIC data, for banks with a current FDIC-insured institution.
6. **Reproducible code** for every step.

The dataset does **not** include the text of consumer narratives (see *Ethics and privacy* below).

---

## Files

| File | What it contains |
|---|---|
| `kibbo-cfpb-complaints-harmonized.csv.gz` | One row per complaint (18.2 million rows): the 15 original CFPB fields plus 13 Kibbo-added fields. |
| `complaints-parquet.zip` | The same file in Parquet format, partitioned by year (`year=YYYY/`), for faster analysis. Unzip before use. |
| `complaints-by-year.csv` | Complaints per year. |
| `complaints-by-year-product-family.csv` | Complaints per year and product family. |
| `complaints-by-year-product-family-response.csv` | The same, split by how the company closed the complaint. |
| `template-category-by-year-product-family-narratives-only.csv` | Share of narratives in each template category, by year and product family. |
| `company-comparisons-2023-08-25-onwards.csv` | For companies with 500+ complaints since 25 August 2023: complaints by product family, template category and company response, plus an all-industry baseline. |
| `complaints-per-100k-all-by-state-year.csv`, `complaints-per-100k-excl-credit-reporting-by-state-year.csv`, `complaints-per-100k-by-state-year-product-family.csv` | Complaints per 100,000 residents by state and year (all complaints; excluding credit reporting; by product family). |
| `bank-complaint-rates.csv` | Complaint rates for 2023–2025: all complaints and bank-accounts-only complaints per $1 billion of domestic deposits, all complaints per $1 billion of total assets, and bank-accounts complaints per 100,000 deposit accounts of $250,000 or less, for banks with a current FDIC-insured institution. |
| `top100-template-clusters.csv` | The 100 largest near-duplicate text clusters, with size, number of distinct locations, date range, main companies and the first 300 characters of the template. |
| `product-taxonomy-crosswalk.csv` | Every original CFPB product and sub-product, its product family, and the dates it was in use. |
| `company-classification-top200.csv` | Business type of the 200 most-complained-about companies. |
| `data-dictionary.csv` | Every column in every file, with type, share of empty values, an example and a description. |
| `scripts.zip` and `requirements.txt` | The code used to build everything (see *Reproducing the analysis* below), with exact package versions. |
| `research-log.md` | Running log of the investigation's research process. |
| `checksums.txt` | SHA-256 checksums for every file. |

---

## Sources

- **CFPB Consumer Complaint Database**, full download from consumerfinance.gov (files.consumerfinance.gov/ccdb/complaints.csv.zip), downloaded 3 October 2026. 18,167,713 complaints received from 1 December 2011 to 3 October 2026.
- **CFPB Consumer Complaint Database Narratives Archive**, 21 files from the CFPB FOIA Electronic Reading Room, downloaded 3 October 2026. On 14 August 2026 the CFPB stopped publishing new narratives in its public database and moved existing ones to this archive. 3,851,415 narratives, from 19 March 2015 to 14 August 2026. Narratives were linked to the main database by Complaint ID (99.9% match in a 5,000-record test).
- **U.S. Census Bureau population estimates**: Vintage 2019 (2012–2019) and Vintage 2025 (2020–2025), state totals, from census.gov.
- **FDIC BankFind Suite** (api.fdic.gov): institution matching and year-end domestic deposits.

---

## Reproducing the analysis

### 1. Download the raw CFPB files
- **Consumer Complaint Database**: https://files.consumerfinance.gov/ccdb/complaints.csv.zip
- **Narratives Archive** (21 files): https://www.consumerfinance.gov/foia-requests/foia-electronic-reading-room/cfpb-consumer-complaint-database-narratives-archive/ (`scripts/download-narratives.sh` downloads all 21 from there)

Census and FDIC data are downloaded automatically by the scripts themselves (Steps 6 and 7).

### 2. Set up the folder layout
Set the environment variable `CFPB_BASE` to a working folder, then arrange the raw files under it:
```
CFPB_BASE/
├── raw/
│   ├── ccdb/complaints.csv          (unzipped from complaints.csv.zip)
│   ├── narratives/extracted/*.csv   (all 21 files, unzipped)
│   └── census/                      (created automatically by step6_enrich.py)
├── scripts/                         (unzip scripts.zip here)
└── package/tables/                  (needed by scripts/chart8_bank_complaints_per_100k_accounts.py)
```
Every script reads `CFPB_BASE` (falling back to the current working directory if unset) and builds every other path from it — no personal or machine-specific paths are hard-coded.

### 3. Run the scripts, in order
| Script | Produces |
|---|---|
| `inventory.py` | A full inventory of the raw download: totals, every column's type/emptiness, product/issue history, narrative coverage. |
| `step2_crosstabs.py` | Cross-tabulations: product families, the 2025 money-transfer spike, company fingerprints, credit reporting, debt collection, narrative coverage, pending complaints. |
| `step3_narratives.py` | Narrative samples and term/duplicate checks for specific complaint waves and company/issue combinations. |
| `step4_templates.py` (calls `step4_year_worker.py` once per year, and twice for 2025) | Template detection for every narrative — exact, normalised and fuzzy (MinHash) duplicates — plus the 100 largest template clusters. |
| `step5_filers.py` | Separates "one person filing against several companies" from "a template shared by different people", using a date + ZIP/state filer key. |
| `step5b_strict.py` | A stricter, location-only filer key (fixes false positives where the same person re-filed on a different day). |
| `step6_enrich.py` | Company comparisons, Census-based state population rates, and the top-200 company list for manual classification. |
| `step7_package.py` | Builds the full package (complaint-level file, tables, data dictionary, checksums) and queries the FDIC BankFind API for candidate bank matches. |
| `step7b_fdic_fix.py` | Corrects 4 FDIC institution matches and builds `fdic-selected.csv` and the first version of the bank-rates table. |
| `step7c_fairer_rates.py` | Adds bank-accounts-only and total-assets denominators to the bank-rates table. |
| `step7d_accounts_denominator.py` | Adds the FDIC deposit-account-count denominator and the matching data-dictionary rows. |
| `chart8_bank_complaints_per_100k_accounts.py`, `chart9_narratives_by_month.py` | Two small chart-ready exports used in the investigation's figures. |

### 4. Software
Python 3 plus the packages and exact versions listed in `requirements.txt`.

### 5. Hardware note
The raw CFPB files total about 9 GB. The template-detection step (`step4_templates.py`) is the heaviest: it needed roughly 14 GB of RAM and several hours, which is why it processes one calendar year at a time (and 2025 in two halves) rather than the whole archive at once.

---

## Methodology

### Product families
The 21 product names the CFPB has used since 2011 are mapped to 11 families (credit reporting, debt collection, mortgage, bank accounts, credit and prepaid cards, money transfers and virtual currency, student loans, vehicle and consumer loans, payday and personal loans, debt and credit management, other). Issue categories also changed in 2017 and 2023 and are not harmonised: compare issues only within the same taxonomy period.

### Template detection (narratives only)
Three levels, applied to every narrative:
1. **Exact duplicate**: identical raw text to at least one other narrative.
2. **Normalised duplicate**: identical after lowercasing and removing CFPB redaction marks (XXXX), numbers and punctuation.
3. **Near-duplicate (fuzzy)**: MinHash with locality-sensitive hashing on word 5-shingles of the normalised text, 128 permutations, Jaccard similarity threshold 0.8, grouped into clusters. Narratives under 30 words (9.5%) were not assessed at this level. Because of computing limits, clusters were built within each calendar year, and within each half of 2025.

A hand check of 100 near-duplicate pairs found them to be genuinely near-identical text. A further check of 50 pairs just below the threshold (similarity 0.6–0.8) found that most were also the same template with more edits, so **the template figures are conservative**.

### Separating shared templates from one person filing several times
The CFPB does not publish who filed each complaint. A text group (narratives with the same normalised text, or in the same near-duplicate cluster) is classified as:
- **shared_template_strict** if it appears in two or more distinct locations (published ZIP code, or state when the ZIP is masked);
- **same_filer_repeat** if every member comes from a single location — most likely one person filing the same text against several companies, or re-filing.

Two different people in the same ZIP code using the same template count as one location, so `shared_template_strict` is a **lower bound**. A hand check of 30 pairs found 3 where the two ZIP codes shared the same first three digits and might be the same person.

### Company business types
Business types were assigned by Kibbo Research. 119 of the 200 classifications rest on the company's well-established public identity (`basis = known`); 81, mostly smaller debt collectors, rest on the company name and on most of its complaints being about debt collection (`basis = profile`) and were not individually verified.

---

## Limitations — please read before using

- **A complaint is an allegation, not a finding.** The CFPB does not verify the facts in complaints, and complaints are not a representative sample of consumer experiences.
- **Company responses are self-reported.** "Closed with monetary relief" and similar categories are reported by the company and not verified by the CFPB. A company that refunds a consumer but records the complaint as "Closed with explanation" will appear to give no monetary relief.
- **Template ≠ fake.** A narrative that matches others shows standardised wording. A real person with a real problem can use a template. This dataset measures standardisation, not legitimacy.
- **Narratives cover only part of the database.** Only about 21% of complaints have a published narrative, and the share varies a lot by product and year (for example, very few credit reporting narratives were published in 2026). Template percentages refer to narratives only.
- **2026 is incomplete**, and about 12% of 2026 credit reporting complaints were still "In progress" when the data was downloaded.
- **The CFPB truncates some ZIP codes**, which affects the location-based template categories.
- **"Servicer under contract with Federal Student Aid"** is a placeholder label used when borrowers don't know their servicer, not a company. Its 7,524 complaints (2024–2026) are all recorded as untimely.
- **Company names** are as published by the CFPB; parent companies and subsidiaries may appear separately.

---

## Ethics and privacy

- The dataset contains **no narrative text**, except the first 300 characters of the 100 largest template clusters, which are mass-repeated texts rather than individual accounts.
- It contains **no derived identifiers** (such as combinations of ZIP code and date) beyond the fields the CFPB itself publishes.
- Narratives remain available from the CFPB's own Narratives Archive for researchers who need them.

---

## How to cite

Kibbo Research (2026). *The CFPB Complaint Vault Dataset* (Version 1.0) [Data set]. Zenodo. https://doi.org/10.5281/zenodo.23188842

When using figures from the investigation itself, please also cite: Kibbo Research (2026). *The Copy-Paste Complaint: How Templates Took Over America's Financial Complaint Database.* getkibbo.com. (https://www.getkibbo.com/investigations/cfpb-copy-paste-complaints)

## Corrections and contact

Errors found after publication are logged at getkibbo.com/corrections-log and fixed in a new version of this dataset. Contact: hello@getkibbo.com
