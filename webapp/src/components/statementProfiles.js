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
//     parse(text) => {                                      // raw file -> table
//       headers, rows,
//       suggestedSource?,                                   // "OSCU Checking …1234"
//       derivedColumns?, defaultMapping?,                   // per-FILE overrides
//     },
//     derivedColumns?: [ { name, compute(row) } ],           // synthesized cols
//     defaultMapping?: { [csvColumnName]: fieldKey|false },  // pins column->field
//   }
//
// `derivedColumns` / `defaultMapping` may be declared statically on the profile
// OR returned from `parse` (the parse result wins). The returned form exists
// because a bank can change its export layout without changing its identity:
// one profile then detects which vintage of file it was handed and hands back
// the mapping for that vintage, instead of forcing the user to know which of
// two near-identically-named entries to pick out of the format list.
//
// A `defaultMapping` value of `false` pins a column to NO field. That is not
// the same as leaving it out: an omitted column falls through to header
// auto-matching, and because the mapper writes one key per column with the LAST
// writer winning, an auto-matched column can silently overwrite a good value
// (an always-empty "Effective Date" landing on `date` after the real one).

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

/**
 * Tokenize CSV text into records of fields (RFC 4180-ish).
 *
 * Quoted fields may contain commas, newlines and "" escapes. A quote is only
 * special at the START of a field, so an unquoted `5" pipe` keeps its quote
 * rather than swallowing the rest of the line. Blank lines are dropped rather
 * than failing the column-count check downstream.
 *
 * Each record carries the 1-based line it STARTED on: a newline inside a quoted
 * field makes "record index" and "file line" diverge, and a parse error has to
 * point at something the user can actually find in their file.
 *
 * @returns {{ fields: string[], line: number }[]}
 */
export function parseCSVRecords(text) {
    const src = String(text ?? "");
    const records = [];

    let fields = [];
    let field = "";
    let inQuotes = false;   // inside a quoted field right now
    let quotedField = false; // this field opened with a quote (so "" is content)
    let started = false;    // some character of this record has been consumed
    let line = 1;
    let recordLine = 1;

    const endField = () => {
        fields.push(field);
        field = "";
        quotedField = false;
    };
    const endRecord = () => {
        endField();
        // A blank line tokenizes to one empty unquoted field; that is not a row.
        const blank = fields.length === 1 && fields[0] === "" && !started;
        if (!blank) records.push({ fields, line: recordLine });
        fields = [];
        started = false;
    };

    for (let i = 0; i < src.length; i++) {
        const c = src[i];

        if (inQuotes) {
            if (c === '"') {
                if (src[i + 1] === '"') { field += '"'; i++; } // escaped quote
                else inQuotes = false;                          // closing quote
            } else if (c === "\r") {
                if (src[i + 1] === "\n") i++;
                field += "\n"; // normalize newlines inside a quoted value
                line++;
            } else {
                if (c === "\n") line++;
                field += c;
            }
            continue;
        }

        if (c === "\n" || c === "\r") {
            endRecord();
            if (c === "\r" && src[i + 1] === "\n") i++;
            line++;
            continue;
        }

        // Anything that is not a line ending starts (or continues) a record
        if (!started) { recordLine = line; started = true; }

        if (c === '"' && field === "" && !quotedField) {
            inQuotes = true;
            quotedField = true;
        } else if (c === ",") {
            endField();
        } else {
            field += c;
        }
    }

    if (started || field !== "" || fields.length > 0) endRecord();

    return records;
}

/**
 * Turn tokenized records into a { headers, rows } table, treating the record at
 * `skipRecords` as the header row (everything before it is ignored preamble).
 * Throws CSVParseError on a row whose column count doesn't match the header,
 * reporting the ORIGINAL 1-based file line so the user can find it.
 */
function buildTable(records, { skipRecords = 0 } = {}) {
    const body = records.slice(skipRecords);
    const headers = (body[0]?.fields ?? []).map(h => cleanExcelStringValue(h).trim());
    const rows = [];

    for (let i = 1; i < body.length; i++) {
        const { fields, line } = body[i];
        if (fields.length !== headers.length) {
            console.error("Error parsing CSV: ", {
                line_number: line,
                expected: headers.length,
                got: fields.length,
                parsed_values: fields,
            });
            throw new CSVParseError(
                `CSV parsing error on line ${line}: expected ${headers.length} values, but got ${fields.length}.`,
                "That row has a different number of columns than the header row. A value containing a comma has to be quoted for the comma to count as part of the value."
            );
        }
        const row = {};
        for (let j = 0; j < headers.length; j++) {
            row[headers[j]] = cleanExcelStringValue(fields[j]);
        }
        rows.push(row);
    }

    return { headers, rows };
}

// ---------------------------------------------------------------------------
// Generic profile: the default. First line is the header row, no derived
// columns.
// ---------------------------------------------------------------------------

export const GENERIC_PROFILE = {
    id: "generic",
    label: "Generic CSV",
    parse(text) {
        return buildTable(parseCSVRecords(text), { skipRecords: 0 });
    },
};

// ---------------------------------------------------------------------------
// Oregon State Credit Union
// ---------------------------------------------------------------------------
//
// OSCU has shipped two different export layouts, and this profile reads both:
// files exported before the change still import (and still produce the same
// dedupe keys they always did), so an old download in the user's ~/Downloads
// does not silently become garbage.
//
// LEGACY layout, with a 3-line preamble:
//   Account Name : Value Checking,,,,,,,
//   Account Number : 442338K0090,,,,,,,
//   Date Range : 06/20/2026-07/19/2026,,,,,,,
//   Transaction Number,Date,Description,Memo,Amount Debit,Amount Credit,Balance,Check Number
//
// CURRENT layout, every field quoted and no preamble observed:
//   "Transaction ID","Posting Date","Effective Date","Transaction Type",
//   "Posting Status","Amount","Check Number","Reference Number","Description",
//   "Transaction Category","Type","Balance","Memo","Extended Description"
//
// The two are told apart by the first header cell alone (Number vs. ID), which
// is also the field whose meaning changed most -- see the mappings below.
//
// DEDUPE HAZARD (nothing here can fix it; it is worth knowing about): items are
// deduped on (source, key), and the two layouts derive their key from different
// columns, because the legacy Transaction Number does not appear anywhere in
// the current export. Re-importing a date range that was already imported from
// a legacy file will therefore list those bank lines again as pending rather
// than recognizing them. Import the current format from where the legacy
// imports left off, and treat any overlap as needing a manual look.

const OSCU_HEADER_RE = /^Transaction (Number|ID)$/i;
const OSCU_AMOUNT_COLUMN = "Signed amount";
const OSCU_KEY_COLUMN = "Dedupe key";

// --- Legacy layout ---------------------------------------------------------
//
// Two structural quirks vs. what the importer wants:
//   - split Amount Debit / Amount Credit columns (debits already negative,
//     credits positive; exactly one populated per row) -> one signed amount.
//   - Transaction Number encodes date+amount+type but NOT the merchant, so it
//     collides on same-day/same-amount/same-type rows. Pair it with Memo (which
//     carries merchant + a per-line auth id) for a stable, unique dedupe key.

const OSCU_LEGACY_DERIVED_COLUMNS = [
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
        compute: (row) => {
            const txn = String(row["Transaction Number"] ?? "").trim();
            const memo = String(row["Memo"] ?? "").trim();
            return `${txn}|${memo}`;
        },
    },
];

const OSCU_LEGACY_MAPPING = {
    [OSCU_AMOUNT_COLUMN]: "amount",
    [OSCU_KEY_COLUMN]: "key",
    "Memo": "note",
    // The raw columns the two derived ones replace. Derived columns are
    // appended after the real ones and so already won on last-writer-wins, but
    // pinning them says so instead of leaning on column order.
    "Transaction Number": false,
    "Amount Debit": false,
    "Amount Credit": false,
    "Check Number": false,
    "Balance": false,
};

// --- Current layout --------------------------------------------------------
//
// Both of the legacy quirks are gone, so this layout needs no derived columns
// at all: Amount is a single already-signed column, and Transaction ID ends in
// a per-transaction sequence number ("20260906 216838 216 16,234,746,633"), so
// it identifies a line on its own without being paired with descriptive text.
//
// What arrived instead is punctuation: every field is quoted and several
// routinely contain commas -- the grouped digits in that sequence number, and
// merchant names like "Spec's Wine, Spirits & Finer Foods". A naive comma split
// mangles every row of this layout, which is why the tokenizer above had to
// grow real quote handling.
//
// Merchant text moved too. Memo is empty throughout; the clean merchant name is
// in Description ("Burger King"), with the raw bank string in Extended
// Description ("Debit Card purchase BURGER KING #*6800 5814 ROCHESTER WA").
// Description is the better note -- the raw string is still one remap away in
// the column list if a particular import wants it.

const OSCU_CURRENT_MAPPING = {
    "Transaction ID": "key",
    "Posting Date": "date",
    "Amount": "amount",
    "Description": "note",
    // Every remaining column is pinned unmapped ON PURPOSE: each of these
    // auto-matches a field it must not win, and it would win, since it sits
    // to the right of the column that holds the real value. Effective Date is
    // empty in every observed row and would clobber the date; Check Number and
    // Reference Number would clobber the key; Memo (also empty) and Extended
    // Description would clobber the note.
    "Effective Date": false,
    "Transaction Type": false,
    "Posting Status": false,
    "Check Number": false,
    "Reference Number": false,
    "Transaction Category": false,
    "Type": false,
    "Balance": false,
    "Memo": false,
    "Extended Description": false,
};

function oscuSuggestedSource(preambleRecords) {
    const find = (label) => {
        for (const { fields } of preambleRecords) {
            const m = (fields[0] ?? "").match(new RegExp(`^\\s*${label}\\s*:\\s*(.+?)\\s*$`, "i"));
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
        const records = parseCSVRecords(text);
        const headerIdx = records.findIndex(r => OSCU_HEADER_RE.test((r.fields[0] ?? "").trim()));
        if (headerIdx === -1) {
            throw new CSVParseError(
                "This doesn't look like an Oregon State Credit Union export: no header row starting with 'Transaction ID' or 'Transaction Number' was found.",
                "If this is a different bank, choose the 'Generic CSV' format instead."
            );
        }

        // Legacy files lead with "Transaction Number", current ones with
        // "Transaction ID" -- see the two mappings above for what differs.
        const legacy = /number/i.test(records[headerIdx].fields[0]);

        return {
            ...buildTable(records, { skipRecords: headerIdx }),
            suggestedSource: oscuSuggestedSource(records.slice(0, headerIdx)),
            derivedColumns: legacy ? OSCU_LEGACY_DERIVED_COLUMNS : [],
            defaultMapping: legacy ? OSCU_LEGACY_MAPPING : OSCU_CURRENT_MAPPING,
        };
    },
};

// Registry the import modal renders as a picklist. Generic first (the default).
export const STATEMENT_PROFILES = [ GENERIC_PROFILE, OSCU_PROFILE ];
