#!/usr/bin/env node
/**
 * Seed the running SCRATCH server (scripts/scratch-server.sh) with realistic
 * data for hand-testing the bank-statement workflows. Drives the HTTP API
 * (auth disabled) rather than the model layer, so it exercises exactly the
 * code paths the webapp uses and never drifts from the API contract.
 *
 * All dates are RELATIVE TO TODAY so the seeded state always lands inside
 * the webapp's matching windows:
 *  - a funds hierarchy (pool + category envelopes + a monthly fund + an
 *    untracked "External World" endpoint for purchases/income)
 *  - RECONCILED history over the past ~6 weeks with recurring vendor notes
 *    (Costco, Safeway, Shell, Netflix, DoorDash, Regal) -> feeds the
 *    inline-reconcile HISTORY PREFILL on matching pending items
 *  - a PENDING queue mixing: prefill hits, a no-history item, an income
 *    deposit, a pre-entered group match and a transfer second side (both
 *    feed the "likely match" LINK SUGGESTIONS), and two ignored items
 *
 * @author Claude <noreply@anthropic.com>
 * Reviewed-by: Jonathan D. B. Van Schenck <jvschenck@novadynamics.com>
 */
const dayjs = require("dayjs");

const BASE = process.env.YDD_SCRATCH_URL ?? "http://localhost:1234";

/** 'YYYY-MM-DD' for `days_ago` days before today. */
const D = (days_ago) => dayjs().subtract(days_ago, "day").format("YYYY-MM-DD");

async function api(method, path, body) {
    const res = await fetch(BASE + path, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if ( !res.ok ) {
        throw new Error(`${method} ${path} -> ${res.status}: ${json?.message ?? "(no message)"}`);
    }
    // Writes return { data, invalidations }; list GETs return bare arrays
    return json?.data ?? json;
}

async function main() {
    const existing = await api("GET", "/api/funds/funds");
    if ( existing.length > 0 ) {
        throw new Error("Scratch db is not empty -- run scripts/scratch-server.sh (reset) instead of seeding directly");
    }

    // --- Funds ----------------------------------------------------------
    // Envelopes carry start balances instead of seeding funding transfers;
    // START is backdated so history purchases never predate their funds.
    const START = dayjs().subtract(8, "month").startOf("month").format("YYYY-MM-DD");
    const fund = async (spec) => (await api("POST", "/api/funds/funds", spec)).id;

    const pool = await fund({ name: "Main Pool", tracked: true, pool: true, start_date: START, start_balance: 5000, color: "amber" });
    const groceries = await fund({ name: "Groceries", tracked: true, parent_id: pool, start_date: START, start_balance: 600, color: "fern" });
    const dining = await fund({ name: "Dining Out", tracked: true, parent_id: pool, start_date: START, start_balance: 250, color: "ember" });
    const gas = await fund({ name: "Gas & Auto", tracked: true, parent_id: pool, start_date: START, start_balance: 300, color: "sky" });
    const subs = await fund({ name: "Subscriptions", tracked: true, parent_id: pool, start_date: START, start_balance: 100, color: "indigo" });
    const savings = await fund({ name: "Savings", tracked: true, parent_id: pool, start_date: START, start_balance: 2500, color: "teal" });
    const fun = await fund({ name: "Fun Money", tracked: true, monthly: true, parent_id: pool, start_date: START, start_balance: 150, color: "magenta" });
    // Untracked endpoint: purchases flow INTO it, income flows OUT of it
    const external = await fund({ name: "External World", tracked: false });

    // --- Statement import helper ---------------------------------------
    const CHK = "OSCU Checking";
    const CC = "OSCU Credit Card";
    const importItems = async (items) => {
        const res = await api("POST", "/api/statements/statements/import", { items });
        return Object.fromEntries(res.created.map(i => [ i.key, i.id ]));
    };

    // --- Reconciled history (drives the prefill matcher) ----------------
    // Notes deliberately share their LEADING tokens with the pending items
    // below ("COSTCO WHSE ..." etc.) while store numbers/cities differ.
    const history = [
        { source: CC, key: "cc-h01", amount: -95.12, date: D(45), note: "COSTCO WHSE #0666 TIGARD OR", from: groceries, desc: "Costco run" },
        { source: CC, key: "cc-h02", amount: -112.40, date: D(24), note: "COSTCO WHSE #0666 TIGARD OR", from: groceries, desc: "Costco run" },
        { source: CC, key: "cc-h03", amount: -41.77, date: D(38), note: "SAFEWAY STORE 1442 BEAVERTON OR", from: groceries, desc: "Safeway groceries" },
        { source: CC, key: "cc-h04", amount: -52.30, date: D(17), note: "SHELL OIL 57444229 PORTLAND OR", from: gas, desc: "Gas" },
        { source: CC, key: "cc-h05", amount: -15.49, date: D(33), note: "NETFLIX COM 866-579-7172 CA", from: subs, desc: "Netflix" },
        { source: CC, key: "cc-h06", amount: -28.60, date: D(20), note: "DOORDASH ORDER 8842 SAN FRANCISCO", from: dining, desc: "DoorDash dinner" },
        { source: CHK, key: "chk-h01", amount: -60.00, date: D(30), note: "REGAL CINEMAS 0442 PORTLAND OR", from: fun, desc: "Movie night" },
    ];
    const historyIds = await importItems(history.map(({ source, key, amount, date, note }) =>
        ({ source, key, amount, date, note })));
    for ( const h of history ) {
        await api("POST", "/api/transactions/transaction-groups/from-statements", {
            statement_ids: [ historyIds[h.key] ],
            description: h.desc,
            transactions: [ {
                source_fund_id: h.from,
                target_fund_id: external,
                amount: Math.abs(h.amount),
                description: h.desc,
            } ],
        });
    }

    // --- A pre-entered group (drives a "likely match" suggestion) -------
    await api("POST", "/api/transactions/transaction-groups", {
        date: D(1),
        description: "Dentist copay",
        transactions: [ {
            source_fund_id: pool,
            target_fund_id: external,
            amount: 65,
            description: "Dentist copay",
        } ],
    });

    // --- The pending queue ----------------------------------------------
    const pending = [
        // History-prefill hits (leading note tokens match history above)
        { source: CC, key: "cc-p01", amount: -87.53, date: D(1), note: "COSTCO WHSE #0912 PORTLAND OR" },
        { source: CC, key: "cc-p02", amount: -34.12, date: D(2), note: "SAFEWAY STORE 0788 PORTLAND OR" },
        { source: CC, key: "cc-p03", amount: -48.90, date: D(0), note: "SHELL OIL 10082334 TIGARD OR" },
        { source: CC, key: "cc-p04", amount: -15.49, date: D(3), note: "NETFLIX COM 866-579-7172 CA" },
        { source: CC, key: "cc-p05", amount: -33.20, date: D(1), note: "DOORDASH ORDER 9971 SAN FRANCISCO" },
        // No history and no matching group: the fully-manual path
        { source: CC, key: "cc-p06", amount: -23.99, date: D(2), note: "AMZN MKTP US 2X4PL9" },
        // Income (positive; nothing matches -- reconcile External World -> Main Pool)
        { source: CHK, key: "chk-p01", amount: 2500.00, date: D(2), note: "PAYROLL ACME CORP DIRECT DEP" },
        // Matches the pre-entered "Dentist copay" group (amount + date)
        { source: CC, key: "cc-p07", amount: -65.00, date: D(0), note: "SMILES DENTAL PORTLAND" },
        // Transfer pair: the checking side is reconciled below, leaving the
        // savings side pending WITH a suggestion pointing at that group
        { source: CHK, key: "chk-p02", amount: -500.00, date: D(2), note: "XFER TO SAVINGS" },
        { source: "OSCU Savings", key: "sav-p01", amount: 500.00, date: D(1), note: "XFER FROM CHECKING" },
        // Noise to ignore (or already ignored, to browse that state)
        { source: CHK, key: "chk-p03", amount: 0.42, date: D(3), note: "INTEREST PAYMENT" },
        { source: CHK, key: "chk-p04", amount: -5.00, date: D(3), note: "MONTHLY SERVICE FEE" },
    ];
    const pendingIds = await importItems(pending);

    await api("POST", "/api/transactions/transaction-groups/from-statements", {
        statement_ids: [ pendingIds["chk-p02"] ],
        description: "Transfer to savings",
        transactions: [ {
            source_fund_id: pool,
            target_fund_id: savings,
            amount: 500,
            description: "Transfer to savings",
        } ],
    });

    await api("PATCH", `/api/statements/statement/${pendingIds["chk-p04"]}`, { ignored: true });

    // --- Report ---------------------------------------------------------
    const items = await api("GET", "/api/statements/statements");
    const counts = items.reduce((acc, i) => (acc[i.state] = (acc[i.state] ?? 0) + 1, acc), {});
    console.log(`Seeded ${BASE}:`);
    console.log(`  8 funds (Main Pool + envelopes + monthly "Fun Money" + untracked "External World")`);
    console.log(`  ${items.length} statement items: ${counts.pending ?? 0} pending, ${counts.reconciled ?? 0} reconciled (history), ${counts.ignored ?? 0} ignored`);
    console.log("");
    console.log("What to expect on /statements (pending view):");
    console.log("  - Costco / Safeway / Shell / Netflix / DoorDash items: funds + description");
    console.log("    PREFILLED from history (confirm with Enter)");
    console.log('  - SMILES DENTAL -65.00: "likely match" suggestion -> the pre-entered');
    console.log('    "Dentist copay" group (one-click Link, or L)');
    console.log('  - XFER FROM CHECKING +500.00: suggestion -> the "Transfer to savings"');
    console.log("    group already reconciling the checking side");
    console.log("  - AMZN MKTP / PAYROLL / INTEREST PAYMENT: no help on purpose (manual");
    console.log("    reconcile, income, and an ignore candidate)");
    console.log("  - J/K, Enter, L, I, R, /, ? drive it all; ? or the corner icon shows help");
}

main().catch(err => {
    console.error(err.message);
    process.exit(1);
});
