
import { useParams, useNavigate } from 'react-router';
import { useState, useEffect, useMemo, useRef, forwardRef } from 'react';
import dayjs from 'dayjs';

import { useUrlFragment } from '../../hooks/URLFragment.jsx';
import {
    useGetUserQuery,
    useGetUserSessionsQuery,
    useGetUserApiKeysQuery
} from '../../hooks/Queries.jsx';
import { useAuth, useAuthRoles } from '../../contexts/AuthContext.jsx';
import Spinner from '../../components/Spinner.jsx';
import { LabeledTextInput, LabeledBooleanInput } from '../../components/Inputs.jsx';
import { Card, CardActionHeader, CardSection, CardAutoGrid, CardErrorSection } from '../../components/Card.jsx';
import { BackLink, AnchorLink } from '../../components/Links.jsx';
import SearchableTable from '../../components/SearchableTable.jsx';
import { IconButton, TightIconButton } from '../../components/Buttons.jsx';
import { EffectiveRoleBadges, ActiveBadge } from '../../components/Badges.jsx';
import {
    EditUserModal,
    DeleteUserModal,
    ChangePasswordModal,
    DeleteSessionModal,
    RevokeAllSessionsModal,
    CreateApiKeyModal,
    DeleteApiKeyModal
} from '../../components/SpecialModals.jsx';
import styles from './User.module.css';


function formatDateTime(value) {
    return value ? dayjs(value).format('YYYY-MM-DD HH:mm') : '—';
}

/** Active until `expires_at`; null means never expires (API keys only). */
function isActive(expiresAt) {
    return expiresAt == null || new Date(expiresAt) > Date.now();
}

/**
 * The profile card: identity + granted role flags, all read-only in place.
 * Email/roles edit through EditUserModal (admin-only -- the PATCH route is
 * admin-gated); passwords through ChangePasswordModal (self-or-admin);
 * deletion through DeleteUserModal (admin, never yourself -- the server
 * refuses self-deletion, so the button hides on your own page).
 */
const ProfileCard = forwardRef(({ user, isSelf, anchor }, ref) => {
    const roles = useAuthRoles();

    const [isEditOpen, setIsEditOpen] = useState(false);
    const [isPasswordOpen, setIsPasswordOpen] = useState(false);
    const [isDeleteOpen, setIsDeleteOpen] = useState(false);

    const navigate = useNavigate();

    return (
        <Card ref={ref}>
            <CardActionHeader
                title={<AnchorLink fragment={anchor} linkText="Profile" />}
            >
                { (roles.admin && !isSelf) &&
                    <IconButton
                        text="Delete"
                        icon="fa-trash"
                        onClick={() => setIsDeleteOpen(true)}
                        buttonClassName={styles.deleteButton}
                    />
                }
                { (isSelf || roles.admin) &&
                    <IconButton
                        text="Change Password"
                        icon="fa-key"
                        onClick={() => setIsPasswordOpen(true)}
                    />
                }
                { roles.admin &&
                    <IconButton
                        text="Edit"
                        icon="fa-pen-to-square"
                        onClick={() => setIsEditOpen(true)}
                    />
                }
            </CardActionHeader>

            <CardSection title="Details">
                <CardAutoGrid>
                    <LabeledTextInput
                        label="ID"
                        value={user.id}
                        isFrozen={true}
                    />
                    <LabeledTextInput
                        label="Email"
                        value={user.email}
                        isFrozen={true}
                    />
                    <LabeledTextInput
                        label="Created"
                        value={formatDateTime(user.created_at)}
                        isFrozen={true}
                    />
                </CardAutoGrid>
            </CardSection>

            <CardSection title="Roles">
                <p className={styles.mutedNote}>
                    The flags below are what was explicitly granted; the effective
                    set is <EffectiveRoleBadges roles={user.roles} /> (admin implies
                    every other role). Role changes take up to ~20 minutes to reach
                    outstanding access tokens.
                </p>
                <CardAutoGrid>
                    <LabeledBooleanInput
                        label="Reader?"
                        value={!!user.reader}
                        isFrozen={true}
                    />
                    <LabeledBooleanInput
                        label="Editor?"
                        value={!!user.editor}
                        isFrozen={true}
                    />
                    <LabeledBooleanInput
                        label="Admin?"
                        value={!!user.admin}
                        isFrozen={true}
                    />
                </CardAutoGrid>
            </CardSection>

            <EditUserModal
                isOpen={isEditOpen}
                setIsOpen={setIsEditOpen}
                user={user}
            />
            <ChangePasswordModal
                isOpen={isPasswordOpen}
                setIsOpen={setIsPasswordOpen}
                user={user}
            />
            <DeleteUserModal
                isOpen={isDeleteOpen}
                setIsOpen={setIsDeleteOpen}
                user={user}
                closePopoutCallback={() => navigate('/users')}
            />
        </Card>
    );
});

/**
 * Active login sessions (expired rows are reclaimed lazily by the server, so
 * a few may linger until the next login sweeps them). Per-session revoke is
 * self-or-admin; revoke-all is only offered on YOUR OWN page (the endpoint
 * only acts on the authed user) and logs this client out too.
 */
const SessionsCard = forwardRef(({ userId, isSelf, anchor }, ref) => {
    const auth = useAuth();

    const [revokeTarget, setRevokeTarget] = useState(null);
    const [isRevokeAllOpen, setIsRevokeAllOpen] = useState(false);

    const sessionsQ = useGetUserSessionsQuery(userId, { orderBy: 'created_at', orderDirection: 'desc' });

    const columns = [
        {
            header: 'Session',
            sortKey: 'id',
            sortable: false,
            render: (session) => (
                <span className="tabular-nums">
                    #{session.id}
                    { session.id === auth.sessionId &&
                        <span className={styles.thisDevice}> (this device)</span>
                    }
                </span>
            )
        },
        {
            header: 'Status',
            sortable: false,
            render: (session) => <ActiveBadge value={isActive(session.expires_at)} />
        },
        {
            header: 'Created',
            sortable: false,
            render: (session) => <span className="tabular-nums">{formatDateTime(session.created_at)}</span>
        },
        {
            header: 'Last used',
            sortable: false,
            render: (session) => <span className="tabular-nums">{formatDateTime(session.last_used_at)}</span>
        },
        {
            header: 'Expires',
            sortable: false,
            render: (session) => <span className="tabular-nums">{formatDateTime(session.expires_at)}</span>
        },
        {
            header: '',
            key: 'actions',
            sortable: false,
            render: (session) => (
                <TightIconButton
                    icon="fa-right-from-bracket"
                    tone="danger"
                    ariaLabel={`Revoke session ${session.id}`}
                    title={session.id === auth.sessionId
                        ? "Revoke this session (logs this device out)"
                        : "Revoke this session (logs that device out)"}
                    onClick={() => setRevokeTarget(session)}
                />
            )
        }
    ];

    return (
        <Card ref={ref} style={{ marginTop: '2rem' }}>
            <CardActionHeader
                title={<AnchorLink fragment={anchor} linkText="Sessions" />}
            >
                { (isSelf && !auth.disableAuth) &&
                    <IconButton
                        text="Revoke All"
                        icon="fa-ban"
                        onClick={() => setIsRevokeAllOpen(true)}
                        buttonClassName={styles.deleteButton}
                    />
                }
            </CardActionHeader>

            <CardSection>
                { sessionsQ.isError
                    ? <CardErrorSection
                        errorMessage={sessionsQ.error.message}
                        errorMessageDetails={sessionsQ.error.details?.message}
                    />
                    : (!sessionsQ.isPending && sessionsQ.data?.length === 0)
                        ? <p className={styles.mutedNote}>No sessions.</p>
                        : <SearchableTable
                            data={sessionsQ.data ?? []}
                            columns={columns}
                            showSearch={false}
                            isLoading={sessionsQ.isPending}
                            onRowClick={null}
                            rowKey="id"
                        />
                }
            </CardSection>

            <DeleteSessionModal
                isOpen={revokeTarget != null}
                setIsOpen={(open) => { if (!open) setRevokeTarget(null); }}
                session={revokeTarget}
            />
            <RevokeAllSessionsModal
                isOpen={isRevokeAllOpen}
                setIsOpen={setIsRevokeAllOpen}
            />
        </Card>
    );
});

/**
 * API keys: mint (the plaintext secret is shown exactly once, inside the
 * mint modal) and revoke. Expired keys stay listed -- the server keeps them
 * visible rather than pruning.
 */
const ApiKeysCard = forwardRef(({ userId, anchor }, ref) => {
    const [isMintOpen, setIsMintOpen] = useState(false);
    const [revokeTarget, setRevokeTarget] = useState(null);

    const apiKeysQ = useGetUserApiKeysQuery(userId, { orderBy: 'created_at', orderDirection: 'desc' });

    const columns = [
        {
            header: 'Name',
            sortable: false,
            render: (apiKey) => apiKey.name
        },
        {
            header: 'Scope',
            sortable: false,
            render: (apiKey) => (
                <EffectiveRoleBadges roles={{ reader: apiKey.reader, editor: apiKey.editor }} />
            )
        },
        {
            header: 'Status',
            sortable: false,
            render: (apiKey) => <ActiveBadge value={isActive(apiKey.expires_at)} />
        },
        {
            header: 'Expires',
            sortable: false,
            render: (apiKey) => apiKey.expires_at
                ? <span className="tabular-nums">{formatDateTime(apiKey.expires_at)}</span>
                : <span className={styles.mutedNote}>never</span>
        },
        {
            header: 'Last used',
            sortable: false,
            render: (apiKey) => <span className="tabular-nums">{formatDateTime(apiKey.last_used_at)}</span>
        },
        {
            header: '',
            key: 'actions',
            sortable: false,
            render: (apiKey) => (
                <TightIconButton
                    icon="fa-trash"
                    tone="danger"
                    ariaLabel={`Revoke API key ${apiKey.name}`}
                    title="Revoke this API key (its secret stops exchanging for access tokens)"
                    onClick={() => setRevokeTarget(apiKey)}
                />
            )
        }
    ];

    return (
        <Card ref={ref} style={{ marginTop: '2rem' }}>
            <CardActionHeader
                title={<AnchorLink fragment={anchor} linkText="API Keys" />}
            >
                <IconButton
                    text="Mint API Key"
                    icon="fa-square-plus"
                    onClick={() => setIsMintOpen(true)}
                />
            </CardActionHeader>

            <CardSection>
                <p className={styles.mutedNote}>
                    API keys mint short-lived access tokens for programmatic clients
                    (never admin). They survive password changes — revoke a key here
                    to kill it. Expired keys stay listed.
                </p>
                { apiKeysQ.isError
                    ? <CardErrorSection
                        errorMessage={apiKeysQ.error.message}
                        errorMessageDetails={apiKeysQ.error.details?.message}
                    />
                    : (!apiKeysQ.isPending && apiKeysQ.data?.length === 0)
                        ? <p className={styles.mutedNote}>No API keys.</p>
                        : <SearchableTable
                            data={apiKeysQ.data ?? []}
                            columns={columns}
                            showSearch={false}
                            isLoading={apiKeysQ.isPending}
                            onRowClick={null}
                            rowKey="id"
                        />
                }
            </CardSection>

            <CreateApiKeyModal
                isOpen={isMintOpen}
                setIsOpen={setIsMintOpen}
                userId={userId}
            />
            <DeleteApiKeyModal
                isOpen={revokeTarget != null}
                setIsOpen={(open) => { if (!open) setRevokeTarget(null); }}
                apiKey={revokeTarget}
            />
        </Card>
    );
});


export default function UserPage() {
    const { fragment } = useUrlFragment();
    const { id: userIdParam } = useParams();
    const auth = useAuth();
    const roles = useAuthRoles();

    const userId = useMemo(() => {
        const parsed = parseInt(userIdParam, 10);
        return isNaN(parsed) ? null : parsed;
    }, [userIdParam]);

    const isSelf = auth.userId != null && auth.userId === userId;
    // Where "back" goes: admins came from the users list; everyone else only
    // ever sees their own page
    const backTo = roles.adminable ? '/users' : '/';
    const backText = roles.adminable ? 'All Users' : 'Home';

    const topRef = useRef(null);
    const profileRef = useRef(null);
    const sessionsRef = useRef(null);
    const apiKeysRef = useRef(null);

    const {
        isPending,
        isError,
        data: user,
        error
    } = useGetUserQuery(userId, { retry: 1, enabled: userId != null });

    // Scroll to the fragment-named card once loaded (same idiom as the fund
    // detail page)
    useEffect(() => {
        if (isPending || isError || !user) return;
        const timeoutId = setTimeout(() => {
            let targetRef = null;
            switch (fragment) {
                case 'profile': targetRef = profileRef; break;
                case 'sessions': targetRef = sessionsRef; break;
                case 'api-keys': targetRef = apiKeysRef; break;
                default: targetRef = topRef; break;
            }

            if (targetRef?.current) {
                const rect = targetRef.current.getBoundingClientRect();
                const isFullyVisible = rect.top >= 0 && rect.bottom <= window.innerHeight;
                if (!isFullyVisible) {
                    targetRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }
        }, 100);
        return () => clearTimeout(timeoutId);
    }, [isPending, isError, user, fragment]);

    if (userId == null || isError) {
        // Foreign users read as 404 for non-admins (and admins without sudo
        // see 403) -- surface what the API said rather than pretending
        const message = userId == null
            ? 'Not a valid user id.'
            : error.details?.message
                ? `${error.message}: ${error.details.message}`
                : error.message;
        const hint = userId != null && error?.status === 404
            ? 'This user does not exist — or belongs to someone else and you are not an administrator in sudo mode.'
            : userId != null && error?.status === 403
                ? 'Enable sudo mode (the toggle in the sidebar) to view other users.'
                : null;
        return (
            <div className={styles.container}>
                <div className={styles.centerState}>
                    <h2 className={styles.errorTitle}>{userId != null && error?.status === 404 ? 'User not found' : 'Error'}</h2>
                    <p>{message}</p>
                    { hint && <p className={styles.mutedNote}>{hint}</p> }
                    <BackLink to={backTo} linkText={backText} />
                </div>
            </div>
        );
    }

    if (isPending) {
        return (
            <div className={styles.container}>
                <div className={styles.loadingContainer}>
                    <Spinner size="2rem" />
                    <span>Loading user details...</span>
                </div>
            </div>
        );
    }

    return (
        <div className={styles.container} ref={topRef}>
            <div className={styles.header}>
                <h1>
                    {user.email}
                    { isSelf && <span className={styles.youHint}> (you)</span> }
                </h1>
                <EffectiveRoleBadges roles={user.roles} />
                { roles.adminable && <BackLink to={backTo} linkText={backText} /> }
            </div>

            <div className={styles.content}>
                <ProfileCard
                    ref={profileRef}
                    user={user}
                    isSelf={isSelf}
                    anchor="profile"
                />

                <SessionsCard
                    ref={sessionsRef}
                    userId={userId}
                    isSelf={isSelf}
                    anchor="sessions"
                />

                <ApiKeysCard
                    ref={apiKeysRef}
                    userId={userId}
                    anchor="api-keys"
                />
            </div>
        </div>
    );
}
