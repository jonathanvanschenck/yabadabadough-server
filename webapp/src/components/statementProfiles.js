// ---------------------------------------------------------------------------
// Statement import profiles
// ---------------------------------------------------------------------------
//
// A "profile" adapts one KIND of bank CSV export to the generic column-mapping
// importer (CSVImporter in SpecialModals.jsx). It sits in FRONT of the mapping
// engine so that importer stays format-agnostic: the profile owns everything
// bank-specific (where the header row starts, how to synthesize a single signed
// amount from split debit/credit columns, how to build a stable dedupe key),
// and hands back the same clean { headers, rows } table the mapper already
// understands, optionally enriched with derived columns.
//
// Adding a new bank = adding one entry to STATEMENT_PROFILES. No importer edits.
//
// A profile is:
//   {
//     id, label,
//     parse(text) => { headers, rows, suggestedSource? },   // raw file -> table
//     derivedColumns?: [ { name, compute(row) } ],           // synthesized cols
//     defaultMapping?: { [csvColumnName]: fieldKey },         // pins column->field
//   }
//
// KNOWN LIMITATION: the shared splitter is a naive comma split (carried over
// from the original importer). It does NOT handle quoted fields containing
// commas. Real exports from the banks we target here don't quote, but a future
// profile whose export does would need a fuller CSV parser at this layer.

export class CSVParseError extends Error {
    constructor(message, details) {
        super(message);
        this.name = "CSVParseError";
        this.details = details;
    }
}

// Excel's string-forcing wrapper: ="value" -> value
function cleanExcelStringValue(value) {
    if (typeof value === "string" && value.startsWith('="') && value.endsWith('"')) {
        return value.slice(2, -1);
    }
    return value;
}

export function splitLines(text) {
    return String(text ?? "").trim().split(/\r\n|\n/);
}

/**
 * Turn already-split lines into a { headers, rows } table, treating the line at
 * `skipLines` as the header row (everything before it is ignored preamble).
 * Throws CSVParseError on a row whose column count doesn't match the header,
 * reporting the ORIGINAL 1-based file line so the user can find it.
 */
function buildTable(lines, { skipLines = 0 } = {}) {
    const body = lines.slice(skipLines);
    const headers = (body[0] ?? "").split(",").map(h => h.trim());
    const rows = [];

    for (let i = 1; i < body.length; i++) {
        const values = body[i].split(",");
        if (values.length !== headers.length) {
            const fileLine = skipLines + i + 1; // 1-based line in the original file
            console.error("Error parsing CSV: ", {
                line_number: fileLine,
                expected: headers.length,
                got: values.length,
                line: body[i],
                parsed_values: values,
            });
            throw new CSVParseError(
                `CSV parsing error on line ${fileLine}: Expected ${headers.length} values, but got ${values.length}. Do your strings have commas in them?`
            );
        }
        const row = {};
        for (let j = 0; j < headers.length; j++) {
            row[headers[j]] = cleanExcelStringValue(values[j]);
        }
        rows.push(row);
    }

    return { headers, rows };
}

// ---------------------------------------------------------------------------
// Generic profile: the default. Reproduces the importer's original behavior
// exactly (first line is the header row, no derived columns).
// ---------------------------------------------------------------------------

export const GENERIC_PROFILE = {
    id: "generic",
    label: "Generic CSV",
    parse(text) {
        return buildTable(splitLines(text), { skipLines: 0 });
    },
};

// ---------------------------------------------------------------------------
// Oregon State Credit Union
// ---------------------------------------------------------------------------
//
// Shape of the export:
//   Account Name : Value Checking,,,,,,,        <- preamble (3 lines)
//   Account Number : 442338K0090,,,,,,,
//   Date Range : 06/20/2026-07/19/2026,,,,,,,
//   Transaction Number,Date,Description,Memo,Amount Debit,Amount Credit,Balance,Check Number
//   <data rows...>
//
// Two structural quirks vs. what the importer wants:
//   - split Amount Debit / Amount Credit columns (debits already negative,
//     credits positive; exactly one populated per row) -> one signed amount.
//   - Transaction Number encodes date+amount+type but NOT the merchant, so it
//     collides on same-day/same-amount/same-type rows. Pair it with Memo (which
//     carries merchant + a per-line auth id) for a stable, unique dedupe key.

const OSCU_HEADER_RE = /^\s*Transaction Number\s*,/i;
const OSCU_AMOUNT_COLUMN = "Signed amount";
const OSCU_KEY_COLUMN = "Dedupe key";

function oscuSuggestedSource(preambleLines) {
    const find = (label) => {
        for (const line of preambleLines) {
            const firstCell = line.split(",")[0];
            const m = firstCell.match(new RegExp(`^\\s*${label}\\s*:\\s*(.+?)\\s*$`, "i"));
            if (m) return m[1].trim();
        }
        return null;
    };

    const name = find("Account Name");
    const number = find("Account Number");
    const last4 = number ? number.replace(/\s/g, "").slice(-4) : null;

    const parts = [ "OSCU" ];
    if (name) parts.push(name);
    if (last4) parts.push("…" + last4);
    // Only a suggestion if we actually recognized something beyond the "OSCU" stub.
    return parts.length > 1 ? parts.join(" ") : null;
}

export const OSCU_PROFILE = {
    id: "oscu",
    label: "Oregon State Credit Union",

    parse(text) {
        const lines = splitLines(text);
        const headerIdx = lines.findIndex(l => OSCU_HEADER_RE.test(l));
        if (headerIdx === -1) {
            throw new CSVParseError(
                "This doesn't look like an Oregon State Credit Union export: no 'Transaction Number, …' header row was found.",
                "If this is a different bank, choose the 'Generic CSV' format instead."
            );
        }

        const table = buildTable(lines, { skipLines: headerIdx });
        const suggestedSource = oscuSuggestedSource(lines.slice(0, headerIdx));
        return { ...table, suggestedSource };
    },

    derivedColumns: [
        {
            name: OSCU_AMOUNT_COLUMN,
            // Debits are stored already-negative, credits positive; exactly one
            // cell is populated per row. Coalesce into a single signed string
            // (renderCSVAmount parses it downstream).
            compute: (row) => {
                const debit = String(row["Amount Debit"] ?? "").trim();
                const credit = String(row["Amount Credit"] ?? "").trim();
                return debit || credit;
            },
        },
        {
            name: OSCU_KEY_COLUMN,
            // Transaction Number alone collides on same-day/same-amount/same-type
            // rows; Memo adds merchant + per-line auth id. Stable across re-exports.
            compute: (row) => {
                const txn = String(row["Transaction Number"] ?? "").trim();
                const memo = String(row["Memo"] ?? "").trim();
                return `${txn}|${memo}`;
            },
        },
    ],

    defaultMapping: {
        [OSCU_AMOUNT_COLUMN]: "amount",
        [OSCU_KEY_COLUMN]: "key",
        "Memo": "note",
    },
};

// Registry the import modal renders as a picklist. Generic first (the default).
export const STATEMENT_PROFILES = [ GENERIC_PROFILE, OSCU_PROFILE ];
