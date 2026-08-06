---
title: "The EU's Transfer of Funds Regulation: What Actually Changed for Your Crypto Transfers"
published: false
description: "Every crypto transfer between EU platforms now requires full sender/receiver data — no minimum amount. But your own hardware wallet only triggers extra checks past €1,000."
tags: crypto, eu, travelrule, compliance
canonical_url: https://www.getkibbo.com/blog/eu-tfr-travel-rule-crypto-transfers
---

*Originally published on [Kibbo](https://www.getkibbo.com/blog/eu-tfr-travel-rule-crypto-transfers). By Carlos Lopez.*

The EU didn't set one threshold for crypto Travel Rule checks — it set two completely different ones, and confusing them is why so many users don't understand why their withdrawal got held.

## Regulation (EU) 2023/1113: Stricter Than the Global Standard

The EU implemented the crypto Travel Rule through the recast Transfer of Funds Regulation (TFR), Regulation (EU) 2023/1113, applicable in full since 30 December 2024. It works alongside MiCA to form the EU's crypto compliance framework, and it's noticeably stricter than the FATF's own suggested global standard in one specific way.

## Two Different Thresholds — Don't Confuse Them

**Threshold 1 — Zero, for CASP-to-CASP transfers.** Unlike the FATF's suggested €1,000 floor (which many jurisdictions, including the US, still use), the EU TFR requires crypto-asset service providers (CASPs) to collect and transmit full originator and beneficiary information on *every* transfer between two regulated platforms, regardless of value — even a transfer of a few euros. There is no minimum amount below which this data-sharing requirement doesn't apply.

**Threshold 2 — €1,000 cumulative, specifically for self-hosted wallet ownership verification.** This is a separate, distinct rule: when you send crypto to or from your own self-hosted (non-custodial) wallet — a hardware wallet, MetaMask, etc. — and the amount exceeds €1,000, assessed cumulatively (meaning multiple smaller transfers to the same address can add up to cross this line), the CASP must specifically verify that you actually own or control that wallet. This is often done through a "Satoshi test" — a small transaction or cryptographic signature proving control of the address.

The confusion between these two rules is genuinely common: people assume the €1,000 figure applies broadly, when it actually applies narrowly to self-custody ownership verification specifically, while the exchange-to-exchange data-sharing requirement applies to everything, with no floor at all.

## What This Means Practically

If your withdrawal to a hardware wallet is held pending verification, you've likely crossed the cumulative €1,000 threshold to that specific address, and your exchange needs to confirm you actually control it — commonly through a small test transaction or a cryptographic signature request. This isn't unique treatment of your account; it's the standard process every CASP in the EU is required to apply once that specific line is crossed.

Self-hosted-to-self-hosted transfers — wallet to wallet, with no CASP involved on either end — currently fall outside TFR's scope entirely, unless a CASP is involved somewhere in the chain.

## What This Means for You

Complete your self-hosted wallet ownership verification with your exchange proactively, before you need to make a time-sensitive withdrawal — this is a one-time process per wallet address in most cases, not something you need to repeat for every transfer once verified. If a hold seems to extend well beyond routine verification, treat it as a separate issue.

Use our [Frozen Account Response Checklist](https://www.getkibbo.com/checklists/frozen-account-response-checklist.html) and [generate a formal response letter](https://www.getkibbo.com/generate/exchange-account-freeze-response.html) if a hold isn't resolved within a reasonable timeframe.

---

**More:** [Frozen Account Response Checklist](https://www.getkibbo.com/checklists/frozen-account-response-checklist.html) · [Exchange Account Freeze/Lockout Response Letter](https://www.getkibbo.com/generate/exchange-account-freeze-response.html) · [Self-Custody Security Checklist](https://www.getkibbo.com/checklists/self-custody-security-checklist.html)

**Sources:** Regulation (EU) 2023/1113 · European Banking Authority — Travel Rule Guidelines (EBA/GL/2024/11)
