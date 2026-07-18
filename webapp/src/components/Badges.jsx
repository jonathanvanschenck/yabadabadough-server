import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
    BooleanIcon,
    FundTypeIcon,
    FundColorDot,
    StatementStateIcon,
    RoleIcon
} from './SpecialIcons.jsx';
import { fundTypeOf, statementStateOf } from './domain.js';
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
 * same everywhere. Returns null for a missing fund (loading states).
 */
export function FundLabel({ fund, dot = true, showType = false, size, className, style, ...rest }) {
    if ( !fund ) return null;
    return <span className={className} style={style} {...rest}>
        {dot && <FundColorDot color={fund.color} size={size} marginRight="0.5rem" />}
        {showType && <FundTypeIcon status={fund.status} marginRight="0.5rem" />}
        <span style={{ color: fundColorVar(fund.color, 'text') }}>{fund.name}</span>
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
