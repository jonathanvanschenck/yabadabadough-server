// ---------------------------------------------------------------------------
// OFX / QFX statement parsing
// ---------------------------------------------------------------------------
//
// The other half of the statement import story (statementProfiles.js is the CSV
// half). OFX is worth supporting for one reason: it is a SPECIFIED format. A
// bank's CSV export is a report, and reports get redesigned -- OSCU has already
// changed theirs once, moving every column and renaming the id, which is the
// kind of break no amount of parser cleverness prevents. OFX has a field named
// FITID whose entire job is to be a stable per-transaction id, and it will
// still be called FITID after the next website redesign.
//
// Two structural things follow from the format that the CSV path does not have
// to think about:
//
//   - ONE FILE, MANY ACCOUNTS. An export is a list of <STMTRS> statements, each
//     naming its own account. That is why the import modal cannot ask for one
//     source up front the way the CSV one does: it has to read the file first,
//     then ask per detected account. An account with no transactions in the
//     window is normal and appears as an empty statement.
//
//   - IT IS SGML, NOT XML (for OFX 1.x, which is what OSCU emits). Leaf
//     elements are usually written with NO closing tag -- `<TRNAMT>75.47` ends
//     at the next `<` -- but the same file may close some of them anyway
//     (`<BALAMT>0.00</BALAMT>` in the very same export). Neither an XML parser
//     nor a regex per field survives that; see parseSGML below for how the tree
//     is built instead.
//
// DEDUPE: OSCU's FITID is character-for-character the same string as the
// "Transaction ID" column of its current CSV export, so items imported from
// either file dedupe against each other correctly -- as long as the SAME source
// label is used for both, which is what the modal's account matching is for.

export class OFXParseError extends Error {
    constructor(message, details) {
        super(message);
        this.name = "OFXParseError";
        this.details = details;
    }
}

/**
 * Decode a downloaded OFX file's bytes to text.
 *
 * OFX declares its own encoding in the header, and OSCU's is CHARSET:1252 --
 * decoding those bytes as UTF-8 turns any accented merchant name into U+FFFD.
 * windows-1252 maps every byte to some character and never throws, so it is the
 * safe first pass to read the header with; only then is it worth re-decoding.
 *
 * @param {ArrayBuffer|Uint8Array} bytes
 * @returns {string}
 */
export function decodeOFXBytes(bytes) {
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const latin = new TextDecoder("windows-1252").decode(buf);

    // OFX 1.x: `CHARSET:1252` / `ENCODING:UTF-8` header lines. OFX 2.x is XML
    // and says `encoding="UTF-8"` in its declaration. Only the head matters.
    const head = latin.slice(0, 2048);
    const utf8 = /ENCODING\s*:\s*UTF-8/i.test(head)
        || /CHARSET\s*:\s*UTF-8/i.test(head)
        || /encoding\s*=\s*["']UTF-8["']/i.test(head);

    if (!utf8) return latin;
    try {
        return new TextDecoder("utf-8", { fatal: false }).decode(buf);
    } catch {
        return latin;
    }
}

/** Cheap sniff, for telling a mis-picked CSV apart from an OFX file up front. */
export function looksLikeOFX(text) {
    const head = String(text ?? "").slice(0, 4096);
    return /OFXHEADER\s*:/i.test(head) || /<OFX>/i.test(head) || /<\?OFX\b/i.test(head);
}

// ---------------------------------------------------------------------------
// SGML tree
// ---------------------------------------------------------------------------

/**
 * Build a tag tree from OFX SGML (and, as a side effect, from OFX 2.x XML).
 *
 * The one rule that makes unclosed leaves work: opening a tag first closes any
 * element that has already collected text, because in OFX an element holds
 * EITHER text or children, never both. So `<TRNAMT>75.47` is closed by the
 * `<FITID>` that follows it, while `<STMTTRN>` -- which never collects text of
 * its own -- stays open for its children. An explicit `</TAG>` still closes
 * through anything left open, so a file that mixes both conventions parses the
 * same either way.
 *
 * @returns {{ tag: string, value: string, children: object[] }} a synthetic root
 */
function parseSGML(text) {
    const root = { tag: "#root", value: "", children: [] };
    const stack = [ root ];
    const src = String(text ?? "");

    const top = () => stack[stack.length - 1];
    const addText = (raw) => {
        const trimmed = raw.trim();
        if (trimmed) top().value += (top().value ? " " : "") + trimmed;
    };

    let i = 0;
    while (i < src.length) {
        const lt = src.indexOf("<", i);
        if (lt === -1) { addText(src.slice(i)); break; }
        if (lt > i) addText(src.slice(i, lt));

        const gt = src.indexOf(">", lt);
        if (gt === -1) break; // truncated file: keep whatever parsed
        const rawTag = src.slice(lt + 1, gt).trim();
        i = gt + 1;

        // <?xml?> / <?OFX?> processing instructions and <!-- --> are not tags
        if (rawTag.startsWith("?") || rawTag.startsWith("!")) continue;

        if (rawTag.startsWith("/")) {
            const tag = rawTag.slice(1).trim().toUpperCase();
            // Close through anything still open inside this element
            while (stack.length > 1) {
                const popped = stack.pop();
                if (popped.tag === tag) break;
            }
            continue;
        }

        // XML self-closing (<TAG/>): an empty leaf, nothing to push
        const selfClosing = rawTag.endsWith("/");
        const tag = (selfClosing ? rawTag.slice(0, -1) : rawTag)
            .split(/\s/)[0].toUpperCase(); // drop any attributes

        if (!tag) continue;

        // An element holds text OR children: a tag opening after text means the
        // element that collected it is finished.
        while (stack.length > 1 && top().value) stack.pop();

        const node = { tag, value: "", children: [] };
        top().children.push(node);
        if (!selfClosing) stack.push(node);
    }

    return root;
}

/**
 * Depth-first search for descendants with `tag`, NOT descending into a match
 * (so findAll(root, "STMTTRN") returns each transaction once, not its nested
 * leftovers). Searching descendants rather than direct children is deliberate:
 * it makes every lookup below immune to how deeply an unclosed leaf happened to
 * nest the elements that came after it.
 */
function findAll(node, tag, out = []) {
    for (const child of node.children) {
        if (child.tag === tag) out.push(child);
        else findAll(child, tag, out);
    }
    return out;
}

function findOne(node, ...tags) {
    for (const tag of tags) {
        const found = findAll(node, tag);
        if (found.length) return found[0];
    }
    return null;
}

/** The text of the first descendant named `tag`, or "" if there is none. */
function leaf(node, ...tags) {
    const found = node ? findOne(node, ...tags) : null;
    return found ? found.value.trim() : "";
}

// ---------------------------------------------------------------------------
// Field conversion
// ---------------------------------------------------------------------------

/**
 * OFX datetime -> 'YYYY-MM-DD', taking the date the bank STAMPED rather than
 * converting the instant.
 *
 * `20260906000000.000[-08:PST]` is midnight on the 6th as the bank's books see
 * it, and the bank's books are what the user is reconciling against; shifting it
 * into the browser's timezone would silently move transactions across a day
 * boundary depending on who is looking. This also keeps OFX and CSV imports of
 * the same transaction on the same date -- OSCU's CSV "Posting Date" of 9/6/2026
 * is the literal date part here.
 */
export function ofxDate(value) {
    const m = String(value ?? "").trim().match(/^(\d{4})(\d{2})(\d{2})/);
    if (!m) return null;
    const [ , y, mo, d ] = m;
    if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return null;
    return `${y}-${mo}-${d}`;
}

/**
 * OFX amount -> number. Signed, and already signed correctly by the bank
 * (negative = money leaving the account), so TRNTYPE is never consulted.
 *
 * The spec permits either '.' or ',' as the decimal point, which makes a lone
 * comma ambiguous with a thousands separator. Both present means ',' groups;
 * a lone ',' is the decimal point.
 */
export function ofxAmount(value) {
    let raw = String(value ?? "").trim().replace(/[\s+$]/g, "");
    if (!raw) return null;
    if (raw.includes(",") && raw.includes(".")) raw = raw.replace(/,/g, "");
    else if (raw.includes(",")) raw = raw.replace(",", ".");
    const num = parseFloat(raw);
    return isNaN(num) ? null : num;
}

/**
 * Fold <NAME> and <MEMO> into one note.
 *
 * NAME is the tidy merchant ("Burger King") but the spec caps it at 32
 * characters, and OSCU does hit that cap ("Online banking Withdrawal Transf"),
 * so it cannot simply be preferred. MEMO is the untruncated bank string. Where
 * MEMO merely continues NAME the longer one wins on its own; where they say
 * different things -- a truncated NAME next to a MEMO of "Credit Card Payment"
 * -- both are worth keeping, and the note is also what the reconcile search
 * matches against, so more real text is better than less.
 */
export function ofxNote(name, memo) {
    const n = String(name ?? "").trim();
    const m = String(memo ?? "").trim();
    if (!m) return n || null;
    if (!n) return m;
    if (m.toLowerCase().startsWith(n.toLowerCase())) return m;
    return `${n} — ${m}`;
}

const ACCT_TYPE_LABELS = {
    CHECKING: "Checking",
    SAVINGS: "Savings",
    MONEYMRKT: "Money market",
    CREDITLINE: "Credit line",
    CD: "CD",
    CREDITCARD: "Credit card",
};

/** "Checking …0090" -- how an account is named in the UI and in a suggestion. */
export function ofxAccountLabel({ acctType, acctId }) {
    const type = ACCT_TYPE_LABELS[acctType] ?? (acctType || "Account");
    const last4 = ofxAccountLast4({ acctId });
    return last4 ? `${type} …${last4}` : type;
}

/** The trailing 4 digits of an account id, the only part safe to show. */
export function ofxAccountLast4({ acctId }) {
    const digits = String(acctId ?? "").replace(/\D/g, "");
    return digits.length >= 4 ? digits.slice(-4) : null;
}

/**
 * Pick the source label for a detected account, PREFERRING one the user already
 * imported under.
 *
 * This is the whole point of detecting accounts at all. Items dedupe on
 * (source, key), so an account that lands under a freshly-invented label
 * re-imports every line the user already has, already reconciled, as pending.
 * A generated name cannot match what they typed months ago -- OSCU's CSV
 * preamble carried an account NICKNAME ("Value Checking") that the OFX export
 * does not have at all -- but the last four digits survive in both, and in a
 * label the user wrote themselves ("OSCU Value Checking …0090").
 *
 * Matched only when EXACTLY ONE existing source carries those digits: two
 * candidates means the guess would be a coin flip, and the cost of guessing
 * wrong is duplicated history. The selector stays editable either way.
 *
 * @returns {{ source: string|null, matched: boolean }}
 */
export function suggestOFXSource(account, existingSources = [], { prefix = "" } = {}) {
    const last4 = ofxAccountLast4(account);

    if (last4) {
        const hits = existingSources.filter(s => String(s).replace(/\D/g, "").includes(last4));
        if (hits.length === 1) return { source: hits[0], matched: true };
    }

    const label = ofxAccountLabel(account);
    return { source: prefix ? `${prefix} ${label}` : label, matched: false };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Parse an OFX/QFX export into its accounts and their transactions.
 *
 * @returns {{
 *   org: string|null, fid: string|null,
 *   accounts: {
 *     acctId: string, acctType: string, bankId: string|null, currency: string|null,
 *     start: string|null, end: string|null,
 *     balance: number|null, balanceAsOf: string|null,
 *     transactions: { key: string, date: string|null, amount: number|null,
 *                     note: string|null, trnType: string|null, checkNumber: string|null }[],
 *   }[]
 * }}
 * @throws {OFXParseError}
 */
export function parseOFX(text) {
    const src = String(text ?? "");
    if (!looksLikeOFX(src)) {
        throw new OFXParseError(
            "This doesn't look like an OFX file: no <OFX> element or OFXHEADER line was found.",
            "Download the OFX (or QFX) export from your bank, or switch to the CSV importer for a CSV file."
        );
    }

    const root = parseSGML(src);

    // Bank statements and credit-card statements are the same shape under
    // different tag names; the account block differs too (BANK/CC ACCTFROM).
    const statements = [ ...findAll(root, "STMTRS"), ...findAll(root, "CCSTMTRS") ];
    if (!statements.length) {
        throw new OFXParseError(
            "No account statements were found in this OFX file.",
            "The file parsed, but it contains no <STMTRS> statement blocks. It may be an OFX response of a different kind (a profile or signon-only response)."
        );
    }

    const signon = findOne(root, "SONRS");
    const fi = signon ? findOne(signon, "FI") : null;

    const accounts = statements.map((stmt) => {
        const acct = findOne(stmt, "BANKACCTFROM", "CCACCTFROM");
        const tranList = findOne(stmt, "BANKTRANLIST");
        const ledger = findOne(stmt, "LEDGERBAL");

        const transactions = (tranList ? findAll(tranList, "STMTTRN") : []).map((t) => ({
            key: leaf(t, "FITID"),
            date: ofxDate(leaf(t, "DTPOSTED", "DTUSER", "DTAVAIL")),
            amount: ofxAmount(leaf(t, "TRNAMT")),
            note: ofxNote(leaf(t, "NAME", "PAYEE"), leaf(t, "MEMO")),
            trnType: leaf(t, "TRNTYPE") || null,
            checkNumber: leaf(t, "CHECKNUM") || null,
        }));

        return {
            acctId: leaf(acct, "ACCTID"),
            // A credit-card block has no ACCTTYPE; the tag it lives under is the type.
            acctType: leaf(acct, "ACCTTYPE") || (acct?.tag === "CCACCTFROM" ? "CREDITCARD" : ""),
            bankId: leaf(acct, "BANKID") || null,
            currency: leaf(stmt, "CURDEF") || null,
            start: ofxDate(leaf(tranList, "DTSTART")),
            end: ofxDate(leaf(tranList, "DTEND")),
            balance: ledger ? ofxAmount(leaf(ledger, "BALAMT")) : null,
            balanceAsOf: ledger ? ofxDate(leaf(ledger, "DTASOF")) : null,
            transactions,
        };
    });

    return {
        org: leaf(fi, "ORG") || null,
        fid: leaf(fi, "FID") || null,
        accounts,
    };
}
