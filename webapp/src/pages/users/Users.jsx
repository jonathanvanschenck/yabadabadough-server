
import { useCallback, useState, useMemo } from 'react';
import { NavLink, useNavigate } from 'react-router';
import dayjs from 'dayjs';

import { useGetUsersQuery } from '../../hooks/Queries.jsx';
import { useEscalation } from '../../contexts/AuthContext.jsx';
import SearchableTable from '../../components/SearchableTable.jsx';
import { CreateUserModal } from '../../components/SpecialModals.jsx';
import { IconButton } from '../../components/Buttons.jsx';
import { EffectiveRoleBadges } from '../../components/Badges.jsx';
import styles from './Users.module.css';

function UsersTable() {
    const [searchTerm, setSearchTerm] = useState('');
    const [sortKey, setSortKey] = useState('email');
    const [direction, setDirection] = useState('asc');

    const navigate = useNavigate();

    const handleSort = useCallback((key) => {
        if (sortKey === key) {
            setDirection(direction === 'asc' ? 'desc' : 'asc');
        } else {
            setSortKey(key);
            setDirection('asc');
        }
    }, [sortKey, direction]);

    // The query only runs while sudo mode is active (the endpoint requires
    // admin + X-Sudo-Mode); the page gates rendering on the same condition
    const {
        isPending: isQueryPending,
        isError,
        data,
        error
    } = useGetUsersQuery();

    // Client-side filter + sort, flattening the effective roles into a
    // sortable rank (admin > editor > reader > none)
    const processedData = useMemo(() => {
        if (!data) return [];

        let flattened = data.map(user => ({
            ...user,
            role_rank: user.roles.admin ? 3 : user.roles.editor ? 2 : user.roles.reader ? 1 : 0,
        }));

        if (searchTerm.trim()) {
            const searchLower = searchTerm.toLowerCase().trim();
            flattened = flattened.filter(user =>
                user.email?.toLowerCase().includes(searchLower)
            );
        }

        return flattened.sort((a, b) => {
            let aVal = a[sortKey] ?? '';
            let bVal = b[sortKey] ?? '';

            if (typeof aVal === 'number' && typeof bVal === 'number') {
                return direction === 'asc' ? aVal - bVal : bVal - aVal;
            }
            aVal = String(aVal).toLowerCase();
            bVal = String(bVal).toLowerCase();
            return direction === 'asc'
                ? aVal.localeCompare(bVal)
                : bVal.localeCompare(aVal);
        });
    }, [data, searchTerm, sortKey, direction]);

    if (isError) {
        return (
            <div className={styles.centerState}>
                <h2 className={styles.errorTitle}>Error</h2>
                <p>
                    { error.details?.message
                        ? `${error.message}: ${error.details.message}`
                        : error.message
                    }
                </p>
            </div>
        );
    }

    const columns = [
        {
            header: 'Email',
            sortKey: 'email',
            sortable: true,
            render: (user) => (
                <NavLink to={`/user/${user.id}`} onClick={(e) => e.stopPropagation()}>
                    {user.email}
                </NavLink>
            )
        },
        {
            header: 'Roles',
            sortKey: 'role_rank',
            sortable: true,
            render: (user) => <EffectiveRoleBadges roles={user.roles} />
        },
        {
            header: 'Created',
            sortKey: 'created_at',
            sortable: true,
            render: (user) => (
                <span className="tabular-nums">
                    {dayjs(user.created_at).format('YYYY-MM-DD')}
                </span>
            )
        }
    ];

    return (
        <div className={styles.tableWrapper}>
            <SearchableTable
                className={styles.tableContainer}
                data={processedData}
                columns={columns}
                searchValue={searchTerm}
                onSearchChange={setSearchTerm}
                searchPlaceholder="Search users by email..."
                sortKey={sortKey}
                sortDirection={direction}
                onSort={handleSort}
                isLoading={isQueryPending}
                onRowClick={(user) => navigate(`/user/${user.id}`)}
                rowKey="id"
                maxSearchWidth="25rem"
            />
        </div>
    );
}

export default function Page() {
    const { isAdminable, isAdmin, escalate } = useEscalation();

    const [isCreateOpen, setIsCreateOpen] = useState(false);

    // Not an admin at all: mirror the API's stance (this page has nothing
    // for you). The nav only shows the link to adminable users, so this is
    // just the direct-URL fallback.
    if (!isAdminable) {
        return (
            <div className={styles.page}>
                <div className={styles.centerState}>
                    <h2>Admins only</h2>
                    <p>User management requires an administrator account.</p>
                </div>
            </div>
        );
    }

    // Adminable but sudo mode off: every user-management request would 403
    // (the X-Sudo-Mode guard), so prompt the escalation instead of a wall of
    // errors. The sidebar toggler does the same thing.
    if (!isAdmin) {
        return (
            <div className={styles.page}>
                <div className={styles.centerState}>
                    <h2>Sudo mode required</h2>
                    <p>
                        User management is guarded against accidental admin actions:
                        enable sudo mode to proceed (the "Pleb Mode" toggle in the
                        sidebar does the same).
                    </p>
                    <IconButton
                        text="Enter Sudo Mode"
                        icon="fa-user-shield"
                        onClick={escalate}
                    />
                </div>
            </div>
        );
    }

    return (
        <div className={styles.page}>
            <div className={styles.topBar}>
                <h1>Users</h1>
                <IconButton
                    text="Create User"
                    icon="fa-user-plus"
                    ariaLabel="Create a new user"
                    onClick={() => setIsCreateOpen(true)}
                    buttonClassName={styles.createButton}
                />
            </div>

            <UsersTable />

            <CreateUserModal
                isOpen={isCreateOpen}
                setIsOpen={setIsCreateOpen}
            />
        </div>
    );
}
