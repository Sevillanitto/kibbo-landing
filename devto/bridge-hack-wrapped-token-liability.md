---
title: "When a Bridge Gets Hacked, Who Owes You for Your Now-Worthless Wrapped Token?"
published: false
description: "A $292M bridge exploit in April 2026 showed exactly how fast a wrapped token's peg can collapse to zero — and how far the damage spreads to protocols that never touched the vulnerable code themselves."
tags: crypto, defi, security, fintech
canonical_url: https://www.getkibbo.com/blog/bridge-hack-wrapped-token-liability
---

*Originally published on [Kibbo](https://www.getkibbo.com/blog/bridge-hack-wrapped-token-liability). By Carlos Lopez.*

Bridges have produced roughly 40% of all value ever lost to hacks in Web3 — and when one breaks, the damage cascades to protocols that never touched the vulnerable code themselves.

## Why Wrapped Tokens Depend Entirely on the Bridge Holding

A wrapped token (like wBTC, wETH, or a re-staked variant like rsETH) is meant to maintain a 1:1 peg to the original asset it represents, backed by real reserves held in a bridge contract on the origin chain. If that bridge's smart contract is exploited and its reserves drained, the wrapped token instantly loses its backing — its price can collapse toward zero even though nothing happened to the original asset itself, since the wrapped version was never anything more than a claim on reserves that no longer exist.

## A Real Example: The April 2026 Kelp DAO Exploit

This isn't a hypothetical risk. On 18 April 2026, attackers exploited a flaw in Kelp DAO's LayerZero cross-chain bridge configuration, draining approximately 116,500 rsETH (re-staked ETH) — roughly 18% of the token's entire circulating supply, worth around $292 million. The bridge held the reserves backing wrapped rsETH deployed across more than 20 different blockchains, meaning every lending protocol that had accepted rsETH as loan collateral was suddenly exposed to a token that no longer had real backing.

The cascading damage illustrates exactly why bridge exploits are uniquely dangerous compared to a hack confined to a single protocol: Aave froze its rsETH markets within hours, and other protocols like SparkLend and Fluid followed with their own emergency freezes. Aave's own contracts were never touched by the exploit — the damage arrived entirely through exposure to a token whose backing had evaporated elsewhere. Some protocols reported temporary total value locked declines in the billions as depositors rushed to exit any position with rsETH exposure, even where their own specific holdings weren't directly affected.

## What Legal Recourse Actually Exists

Recovery options depend heavily on the bridge's specific structure:

- **If a centralized entity operates or maintains the bridge** (rather than it being purely autonomous, ownerless code), a civil claim against that entity for negligent security practices is at least theoretically available — though as with most DeFi litigation, actually collecting on a judgment against an entity that may be offshore, pseudonymous, or thinly capitalized is a separate and much harder problem than winning the claim itself.
- **If the bridge is genuinely decentralized with no identifiable controlling entity**, recovery options narrow considerably to whatever the protocol's own emergency governance mechanisms allow (insurance funds, treasury-funded partial reimbursement) rather than a traditional legal claim.
- **Document your exposure immediately** regardless of which situation applies — your wallet address, the specific wrapped token and amount held, and the timestamp of your holdings relative to the exploit, since any recovery or reimbursement process (protocol-led or legal) will require this.

## What This Means for You

Before holding a meaningful amount of any wrapped or re-staked token, understand which bridge backs it and how concentrated that bridge's reserves are — a token wrapped across 20+ chains through a single bridge, as in the Kelp DAO case, represents genuine systemic risk beyond the specific protocol you're actually using. Diversifying which bridges and wrapped assets you hold reduces your exposure to any single point of failure.

If you're affected by a bridge exploit, [generate a formal report](https://www.getkibbo.com/generate/crypto-complaint-generator.html) to the relevant regulator, and use our [blockchain explorer directory](https://www.getkibbo.com/directory/crypto-fintech.html#blockchain-explorers) to document your exact exposure.

---

**More:** [Blockchain Explorers Directory](https://www.getkibbo.com/directory/crypto-fintech.html#blockchain-explorers) · [Crypto Complaint Generator](https://www.getkibbo.com/generate/crypto-complaint-generator.html) · [Self-Custody Security Checklist](https://www.getkibbo.com/checklists/self-custody-security-checklist.html)

**Sources:** Multiple industry reports on the Kelp DAO/rsETH LayerZero bridge exploit, April 2026, including coverage from TechRadar and Travers Smith legal analysis.
