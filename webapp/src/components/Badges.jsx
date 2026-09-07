import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
    BooleanIcon,
    FundTypeIcon,
    FundColorDot,
    StatementStateIcon,
    RoleIcon
} from './SpecialIcons.jsx';
import { fundTypeOf, statementStateOf, groupIsOutstanding, daysOutstanding, outstandingIsStale } from './domain.js';
import { fundColorVar } from '../hooks/fundColors.js';

export function Badge({ text, icon, className, style, ...rest }) {
    return <span>
        {icon && <FontAwesomeIcon icon={`fa-solid ${icon}`} widthAuto style={{ marginRight: '0.5rem' }} />}
        <span className={className} style={style} {...rest}>{text}</span>
    </span>;
}

const FUND_TYPE_LABELS = {
    pool: "Pool",
    monthly: "Monthly",
    tracked: "Tracked",
    untracked: "Untracked",
    unknown: "Unknown",
};

/**
 * A fund's type icon plus a label. `label` defaults to the type name
 * ("Pool"/"Monthly"/...); pass the fund's name instead to render a
 * type-decorated fund reference (as the fund selectors do). When rendering a
 * fund reference, pass its `color` slug (null = the neutral default) to tint
 * the name with the fund's readable `-text` color; omit it (undefined) for
 * plain type badges, which stay the ambient text color.
 */
export function FundTypeBadge({ status, label, color, ...rest }) {
    const type = fundTypeOf(status);
    const displayLabel = label ?? FUND_TYPE_LABELS[type];
    const labelStyle = color !== undefined ? { color: fundColorVar(color, 'text') } : undefined;
    return <span title={FUND_TYPE_LABELS[type]}><FundTypeIcon status={status} marginRight="0.5rem" {...rest} /><span style={labelStyle}>{displayLabel}</span></span>;
}

/**
 * A fund reference wherever one is NAMED: its color dot + the fund's name
 * tinted to the fund's `-text` color (neutral default when no color chosen).
 * `size` sizes the dot; set `showType` to also prefix the fund-type icon.
 * Always carries the color as both the dot AND the label so a fund reads the
 * same everywhere. A deprecated fund mutes its name and trails a small
 * archive icon (with the last-active date in the hover title) -- again
 * everywhere, so a dead fund is never mistaken for a live one. Returns null
 * for a missing fund (loading states).
 */
export function FundLabel({ fund, dot = true, showType = false, size, className, style, ...rest }) {
    if ( !fund ) return null;
    const isDeprecated = fund.deprecated != null;
    // Hover reveals the fund's story: deprecation status first (it changes how
    // the fund behaves), then the free-form description when one is set
    const title = [
        isDeprecated ? `Deprecated — last active ${fund.deprecated}` : null,
        fund.description || null,
    ].filter(Boolean).join('\n') || undefined;
    return <span
        className={className}
        style={style}
        title={title}
        {...rest}
    >
        {dot && <FundColorDot color={fund.color} size={size} marginRight="0.5rem" />}
        {showType && <FundTypeIcon status={fund.status} marginRight="0.5rem" />}
        <span style={{ color: isDeprecated ? 'var(--font-muted)' : fundColorVar(fund.color, 'text') }}>{fund.name}</span>
        {isDeprecated && <FontAwesomeIcon
            icon="fa-solid fa-box-archive"
            style={{ marginLeft: '0.4rem', color: 'var(--font-muted)', fontSize: '0.8em' }}
        />}
    </span>;
}

const STATEMENT_STATE_LABELS = {
    pending: "Pending",
    ignored: "Ignored",
    reconciled: "Reconciled",
    unknown: "Unknown",
};

// Tint each state with a semantic `-text` ramp so the column reads at a glance:
// reconciled is done (green), pending wants attention (amber), ignored recedes.
const STATEMENT_STATE_COLORS = {
    pending: "var(--u-warn-text)",
    ignored: "var(--font-muted)",
    reconciled: "var(--u-success-text)",
};

export function StatementStateBadge({ statement, label, ...rest }) {
    const state = statementStateOf(statement);
    const displayLabel = label ?? STATEMENT_STATE_LABELS[state];
    return <span title={displayLabel} style={{ color: STATEMENT_STATE_COLORS[state] }}><StatementStateIcon statement={statement} marginRight="0.5rem" {...rest} />{displayLabel}</span>;
}

/**
 * A transaction group still waiting on its bank line -- a cheque written but
 * not cashed, a pending ACH, a promised refund. Renders nothing when the
 * group is not outstanding, so it can be dropped in unconditionally.
 *
 * Amber is the same "wants attention" register a pending statement item
 * uses (this is the mirror image of that queue, from the ledger's side), and
 * it turns danger-red once the item is older than a bank would honour.
 */
export function OutstandingBadge({ group, today, label, className, ...rest }) {
    if ( !groupIsOutstanding(group) ) return null;

    const days = daysOutstanding(group, today);
    const stale = outstandingIsStale(group, today);
    const displayLabel = label ?? "Outstanding";
    const title = [
        days == null
            ? "Waiting on a bank line"
            : `Waiting on a bank line — ${days} day${days === 1 ? '' : 's'} since ${group.date}`,
        stale ? "Older than most banks will honour — chase it, or clear \u201cexpects a bank line\u201d to write it off." : null,
    ].filter(Boolean).join('\n');

    return <span
        className={className}
        title={title}
        style={{ color: stale ? 'var(--u-danger-text)' : 'var(--u-warn-text)' }}
    >
        {/* The gap belongs BETWEEN icon and label; with no label it would only
          * shove the badge into whatever follows it (the row's ghost buttons) */}
        <FontAwesomeIcon
            icon="fa-solid fa-hourglass-half"
            widthAuto
            style={{ marginRight: displayLabel ? '0.5rem' : 0 }}
            {...rest}
        />
        {displayLabel}
    </span>;
}

export function FinalizedBadge({ value, label, ...rest }) {
    const displayLabel = label ?? (value ? "Finalized" : "Open");
    return <span title={displayLabel}><BooleanIcon value={value} trueIcon="fa-lock" falseIcon="fa-lock-open" marginRight="0.5rem" {...rest} />{displayLabel}</span>;
}

export function RoleBadge({ role, label, ...rest }) {
    const displayLabel = label ?? (role ? role.charAt(0).toUpperCase() + role.slice(1) : "Unknown");
    return <span title={displayLabel}><RoleIcon role={role} marginRight="0.5rem" {...rest} />{displayLabel}</span>;
}

/**
 * A user's effective-role badges in one row, admin-first. `roles` is the
 * API's EFFECTIVE set (admin implies every other role), so an admin always
 * reads "Admin Editor Reader".
 */
export function EffectiveRoleBadges({ roles, style, ...rest }) {
    const active = ["admin", "editor", "reader"].filter(role => roles?.[role]);
    if (active.length === 0) {
        return <span style={{ color: 'var(--font-muted)', ...style }} {...rest}>No roles</span>;
    }
    return (
        <span style={{ display: 'inline-flex', gap: '1rem', flexWrap: 'wrap', ...style }} {...rest}>
            {active.map(role => <RoleBadge key={role} role={role} />)}
        </span>
    );
}

/**
 * Active/expired for sessions and API keys. Derive `value` from expires_at
 * (null means never expires -- API keys only):
 * `expires_at == null || new Date(expires_at) > Date.now()`
 */
export function ActiveBadge({ value, label, ...rest }) {
    const displayLabel = label ?? (value ? "Active" : "Expired");
    return <span title={displayLabel}><BooleanIcon value={value} trueIcon="fa-circle-check" falseIcon="fa-circle-xmark" marginRight="0.5rem" {...rest} />{displayLabel}</span>;
}
