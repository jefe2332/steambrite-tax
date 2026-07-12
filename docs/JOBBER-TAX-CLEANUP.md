# Jobber Tax Settings Cleanup — Safe Procedure (QuickBooks-sync-aware)

## ⭐ THE SIMPLE VERSION — just do these in order

**Two rules that prevent every QuickBooks sync error:** never change a percentage on a rate you've already used (make a new one instead), and re-point everything to the new one BEFORE removing the old.

**About deleting:** Jobber's Tax settings has a Remove button on every rate/group, and deleting there is fine — invoices keep a snapshot of the tax they were billed with, so history won't recalculate. The order matters, not the deletion: switch all properties/quotes off the old item first, then Remove it. If Jobber ever refuses to remove one (attached to something you missed), rename it `zz-OLD …` as the fallback so it sinks to the bottom. QuickBooks is the strict one — it can only DEACTIVATE rates, never delete, and that's fine; deactivated rates disappear from pickers.

**Step 1 — One quick look in QuickBooks (2 min):**
Open QuickBooks → Taxes → Sales tax settings. Note whether "Automated sales tax" is ON or you manage rates manually. That's it — just know the answer.

**Step 2 — Fix Warren County (you're charging 7.0%, it's been 6.75% since Jan 2023):**
In Jobber → Settings → Tax settings:
1. Rename the old group `OH-Warren` → `OH-Warren OLD` (frees up the name; you'll Remove it in step 7)
2. Create Tax Rate: name `Ohio, Warren County 1.0`, rate `1.0`
3. Create Tax Group: name `OH-Warren`, components = `Ohio State (5.75)` + `Ohio, Warren County 1.0` → shows 6.75%
   - (If Step 1 said MANUAL rates: first create the same-named 6.75% combined rate in QuickBooks so the names match. If AST is ON, skip this — QBO calculates by address on its own.)
4. Open your Warren County clients (Mason, Lebanon, Springboro, Maineville…) and switch each property's Tax rate to the new OH-Warren (6.75%). The extension badge shows you which ones.
5. Send one test invoice through to QuickBooks. If a tax warning appears on the QuickBooks dashboard in Jobber, click it and accept its suggested fix (usually "rename to match" or "Add tax rates to Jobber").
6. Once nothing references them anymore: Remove `OH-Warren OLD` and the old `Ohio, Warren County` 1.25 rate. If Jobber blocks the removal, rename to `zz-OLD …` and move on.

**Step 3 — Duplicates (do a week later, only after Step 2 synced clean):**
1. KEEP `OH-Franklin-25000` and `OH-Montgomery-57000` exactly as they are — QuickBooks created those names itself (25000/57000 are Ohio's official codes for COTA and MVRTA), so they sync perfectly. Ugly but bulletproof. Do NOT rename them.
2. Make sure no property/quote uses your hand-made duplicate `OH-Franklin`, then Remove it (use ...-25000 going forward).
3. Rates list: you have both `Ohio, Franklin` and `Ohio, Franklin County` at 1.25. Check which one the surviving `OH-Franklin-25000` group uses (click Select Tax Rates to see) — Remove the OTHER one once nothing uses it.
4. New properties in Franklin County → always pick `OH-Franklin-25000`.
5. In QuickBooks: you can't delete rates there, only mark inactive — deactivate any leftover duplicates and they vanish from the pickers.

**Step 4 — Going forward:**
When the extension's badge disagrees with your Jobber dropdown, a rate changed (only ever on Jan 1 / Apr 1 / Jul 1 / Oct 1). Repeat the Step 2 pattern for that county. Everything else below is the detailed reference version of the same thing.

---


_Written 2026-07-11 from verified July 2026 official Ohio rates + researched Jobber/QBO sync mechanics (sources at bottom). Companion to REBUILD-PLAN.md._

## How the sync actually works (why it "usually throws errors")

Verified from Jobber Help Center + Intuit docs:

1. **Jobber → QBO is one-way and real-time** (NEW integration). Invoices sync **once**; later edits must be made in both systems by hand.
2. **Jobber never creates or updates tax rate definitions in QBO.** On each invoice it matches **by NAME first**; if the name doesn't match, it grabs **"the first instance of that tax rate"** (same percentage, any name) in QBO — nondeterministic when duplicates exist.
3. **QBO can't delete tax rates, only deactivate.** Editing a custom rate that's ever been used makes QBO **inactivate the old and create a new one** (a fork). AST (Automated Sales Tax) rates can't be edited at all.
4. With **AST on**, QBO suggests location-based rates and Jobber **auto-creates matching rates/groups in Jobber** ("New tax group created in Jobber — no further action required").

**SOLVED — the `-25000` / `-57000` suffixes:** these are **official Ohio transit-district FIPS codes** from the state's own jurisdiction files (verified in The Finder's `OHTransitFIPSCodes.txt`): `25000` = COTA (Central Ohio Transit Authority, Franklin County); `57000` = MVRTA (Miami Valley RTA, Montgomery County). QuickBooks' Automated Sales Tax builds its jurisdiction names from these codes, so `OH-Franklin-25000` and `OH-Montgomery-57000` were almost certainly **created by QBO AST and auto-imported into Jobber** — which also strongly implies **AST is ON** in your QBO. Consequence for cleanup: the *suffixed* groups are likely the QBO-authoritative survivors, and your hand-made clean-named ones (`OH-Franklin`) are the redundant copies. Verify in pre-flight #2/#3, but expect the survivor choice to go this way.

**Golden rules:** never edit a used rate's % in place · never delete · names must match QBO byte-for-byte · no colons/slashes/% signs in names · change = create-new + retire-old.

## Current state audit (from screenshots, checked against verified July 2026 rates)

### Component rates
| Jobber rate name | Value | Verdict |
|---|---|---|
| Ohio State | 5.75 | ✅ correct |
| Ohio, Butler | 0.75 | ✅ (6.50% total) |
| Ohio, Central Ohio Trans (COTA) | 1.0 | ✅ (post-Apr-2025 rate) |
| Ohio, Champaign | 1.5 | ✅ (7.25%) |
| Ohio, Clark County | 1.5 | ✅ (7.25%) |
| Ohio, Delaware | 1.25 | ✅ (7.00% base) |
| Ohio, Fayette | 1.5 | ✅ (7.25%) |
| Ohio, Franklin | 1.25 | ✅ — **duplicate of "Ohio, Franklin County"** |
| Ohio, Franklin County | 1.25 | ✅ — duplicate (pick ONE survivor) |
| Ohio, Greene County | 1.0 | ✅ (6.75%) |
| Ohio, Hamilton | 2.05 | ✅ (7.80%; note: 1.25% county + 0.80% SORTA transit combined — fine as one component) |
| Ohio, Highland County | 1.5 | ✅ (7.25%) |
| Ohio, Logan | 1.5 | ✅ (7.25%) |
| Ohio, Miami | 1.25 | ✅ (7.00%) |
| Ohio, Miami Valley Regio (MVRTA) | 0.5 | ✅ |
| Ohio, Montgomery Coun | 1.25 | ✅ (7.50% with MVRTA) |
| Ohio, Preble | 1.5 | ✅ (7.25%) |
| Ohio, Shelby | 1.5 | ✅ (7.25%) |
| **Ohio, Warren County** | **1.25** | ❌ **WRONG — must be 1.0% (dropped Jan 1, 2023). Over-collecting 0.25% since.** |
| Tax Exempt | 0.0 | ✅ keep (QBO also needs a 0% rate or you get "0% tax rate not found") |

### Groups
| Group | Total | Verdict |
|---|---|---|
| OH-Butler 6.5 · OH-Champaign 7.25 · OH-Clark 7.25 · OH-Delaware 7.0 · OH-Fayette 7.25 · OH-Greene 6.75 · OH-Hamilton 7.8 · OH-Highland 7.25 · OH-Logan 7.25 · OH-Miami 7.0 · OH-Preble 7.25 · OH-Shelby 7.25 | — | ✅ all correct |
| OH-Franklin 8.0 / OH-Franklin-25000 8.0 | 8.0 | ✅ rate correct; **duplicates — consolidate** |
| OH-Montgomery-57000 | 7.5 | ✅ rate correct; **suffixed name — consolidate/rename decision below** |
| **OH-Warren** | **7.0** | ❌ **must be 6.75** (proof: extension suggested 6.75 for Mason 45040 while dropdown applied 7.0) |

Optional adds (only if you serve these areas): `OH-Delaware-COTA` 8.0 (Westerville/Columbus slivers inside Delaware County), `OH-Fairfield` 6.75 / `OH-Fairfield-COTA` 7.75, `OH-Licking` 7.25 / `OH-Licking-COTA` 8.25, `OH-Clinton` 7.25, `OH-Darke` 7.25. The rebuilt extension will tell you the exact jurisdiction, so add groups as jobs appear.

## Pre-flight (do BEFORE any change — 10 minutes)

1. **QBO → Taxes → Sales tax settings:** is **Automated Sales Tax (AST)** on, or custom/manual rates? This decides who's the authority. (If AST is on, QBO's suggested names win; Jobber names must be copied from QBO exactly.)
2. **QBO → Taxes:** screenshot the full list of tax rates/groups incl. inactive. Find which QBO objects the names `OH-Warren`, `OH-Franklin`, `OH-Franklin-25000`, `OH-Montgomery-57000` actually correspond to.
3. **Jobber Taxation Report + QBO sales tax liability report:** for each duplicate pair, note which object carries historical invoices. **The history-carrier survives; the empty one gets retired.**
4. Confirm the tax agency ("Ohio Department of Taxation" or similar) exists in QBO.
5. Do everything below **one change at a time**, then check the QuickBooks dashboard in Jobber for warnings before the next change.

## Fix 1 — Warren County 7.0% → 6.75% (do this first; it's live over-collection)

Do NOT just edit the 1.25 component in place (QBO will fork it and you'll mint another suffixed duplicate). Instead:

1. **QBO first:** ensure the target exists — a rate/group that totals 6.75% for Warren with the exact final name (if AST: accept/copy QBO's suggested Warren rate & name; if manual: create combined rate `OH-Warren` = State 5.75 + Warren County 1.0).
2. **Jobber:** Create Tax Rate → name `Ohio, Warren County 1.0` (or match QBO's component naming), rate **1.0**.
3. **Jobber:** Create Tax Group → name **exactly** matching the QBO object (e.g. `OH-Warren` if QBO kept that name after step 1 — if QBO forked to a new name, match THAT), components = Ohio State 5.75 + the new 1.0 rate. Total shows 6.75.
4. **Retire the old:** rename old group `zz-OLD-OH-Warren-7.0` and old rate `zz-OLD Ohio, Warren County 1.25`; make sure no property/template defaults point at them.
5. **Re-point:** any client properties in Warren County (Mason, Lebanon, Franklin-the-city, Springboro…) → select the new group. Open quotes/unsent invoices too. Already-synced invoices: leave them.
6. Send one test invoice through to QBO, confirm no tax warnings.

Note: whichever final group name you choose, tell me — the rebuilt extension's label mapping will emit exactly that name.

## Fix 2 — consolidate duplicates (after Fix 1 is verified clean)

For `Ohio, Franklin` vs `Ohio, Franklin County` (rates) and `OH-Franklin` vs `OH-Franklin-25000` (groups), and the `OH-Montgomery-57000` naming:

1. From pre-flight #3, identify the **history-carrier** in each pair.
2. **Survivor = the one whose name matches the active QBO object** (usually also the history-carrier; if they conflict, the QBO-name-matcher wins — sync stability beats aesthetics; a suffixed name that syncs clean is better than a pretty one that errors).
3. Losers: **rename** in Jobber to `zz-DUP-<oldname>` (do not delete — Jobber objects used on invoices are effectively locked; renaming is safe because synced history is frozen), remove from any defaults. In QBO, **deactivate** the redundant rate only if it is NOT the one active invoices reference.
4. One pair at a time → sync → check warnings → next.

## Naming convention going forward

Minimal-change (recommended now): keep your current clean names, just be **rigorous that Jobber and QBO stay byte-identical**, and prefix retirees with `zz-`. Full convention (optional, later, only with a clean AST-off setup): encode totals in group names (`OH-Warren-6.75`) so staleness is self-evident — but renaming live groups requires renaming both sides simultaneously, so don't do it while sync is fragile.

Character rules (QBO): letters, digits, space and `, . ? @ & ! # ' ~ * ( ) _ - ; +` only. **Never** colon, slash, or %.

## Standing procedure for future Ohio rate changes (quarterly)

Ohio changes land only Jan/Apr/Jul/Oct 1 (60+ days notice; ODT emails bulletins — subscribe at tax.ohio.gov). When the rebuilt extension's data updates and a badge total stops matching your Jobber group: run Fix-1-style create-new + retire-old for that county. 2025 changes for reference: COTA +0.5% (Apr), Lake 7.25% (Jul), Brown 7.00% (Oct); none in 2026 so far.

## Sources
- Jobber Tax Settings: https://help.getjobber.com/hc/en-us/articles/115014367307
- How Items Sync (NEW QBO integration): https://help.getjobber.com/hc/en-us/articles/10487017203223
- Common QB Sync Errors (NEW): https://help.getjobber.com/hc/en-us/articles/10466688449431
- QBO AST sync error / exact-name requirement: https://help.getjobber.com/hc/en-us/articles/360000226608
- Intuit: editing a used custom rate forks it: https://quickbooks.intuit.com/learn-support/en-us/help-article/set-sales-taxes/use-custom-rates-manually-calculate-taxes-invoices/L8Gt91yR4_US_en_US
- Intuit: rates can only be deactivated, never deleted: https://quickbooks.intuit.com/learn-support/en-us/help-article/sales-taxes/delete-sales-tax-rates-agencies/L6JKrQWgQ_US_en_US
- Intuit: allowed characters: https://quickbooks.intuit.com/learn-support/en-us/help-article/account-management/acceptable-characters-quickbooks-online/L3CiHlD9J_US_en_US
