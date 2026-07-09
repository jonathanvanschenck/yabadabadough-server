import { useState, useCallback } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import Spinner from './Spinner.jsx';
import styles from './SearchableTable.module.css';

export default function SearchableTable({
    // Data props
    data = [],
    columns = [],
    
    // Search props
    searchValue = '',
    onSearchChange,
    searchPlaceholder = 'Search...',
    showSearch = true,
    
    // Sorting props
    sortKey,
    sortDirection = 'asc',
    onSort,
    
    // Loading/state props
    isLoading = false,
    isPending = false,
    isStale = false,
    
    // Row interaction props
    onRowClick,
    rowKey = 'id',
    highlightedRowId = null,
    highlightedRowIds = [],
    
    // Styling props
    className = '',
    tableClassName = '',
    stickyHeader = true,
    maxSearchWidth = '25rem'
}) {
    const [localSearchTerm, setLocalSearchTerm] = useState(searchValue);
    
    const handleSearchChange = useCallback((event) => {
        const newValue = event.target.value;
        setLocalSearchTerm(newValue);
        
        if (onSearchChange) {
            onSearchChange(newValue);
        }
    }, [onSearchChange]);
    
    const handleClearSearch = useCallback(() => {
        setLocalSearchTerm('');
        if (onSearchChange) {
            onSearchChange('');
        }
    }, [onSearchChange]);
    
    const handleSort = useCallback((key) => {
        if (onSort) {
            onSort(key);
        }
    }, [onSort]);
    
    const showOverlay = isLoading || isPending;
    const searchTerm = onSearchChange ? searchValue : localSearchTerm;

    return (
        <div className={`${styles.tableContainer} ${className}`}>
            {/* Search input */}
            {showSearch && (
                <div className={styles.searchContainer}>
                    <div className={styles.searchInputWrapper} style={{ maxWidth: maxSearchWidth }}>
                        <input
                            type="text"
                            placeholder={searchPlaceholder}
                            value={searchTerm}
                            onChange={handleSearchChange}
                            className={styles.searchInput}
                        />
                        {searchTerm && (
                            <button
                                type="button"
                                onClick={handleClearSearch}
                                className={styles.searchClearButton}
                                aria-label="Clear search"
                            >
                                <FontAwesomeIcon icon="fa-solid fa-times" />
                            </button>
                        )}
                    </div>
                </div>
            )}
            
            {/* Show loading/sorting overlay */}
            {showOverlay && (
                <div className={styles.loadingOverlay}>
                    <Spinner size="1.2rem" />
                    <span>Loading...</span>
                </div>
            )}
            
            <table 
                className={`${styles.table} ${isStale ? styles.isStale : ''} ${tableClassName}`}
            >
                <thead className={stickyHeader ? styles.stickyHeader : ''}>
                    <tr>
                        {columns.map((column) => (
                            <TableHeader 
                                key={column.key || column.header}
                                column={column}
                                currentSortKey={sortKey}
                                direction={sortDirection}
                                onSort={handleSort}
                                isPending={isPending}
                            />
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {(data || []).map((item) => (
                        <TableRow 
                            key={item[rowKey] || Math.random()}
                            data={item}
                            columns={columns}
                            onRowClick={onRowClick}
                            isHighlighted={item[rowKey] === highlightedRowId || highlightedRowIds.includes(item[rowKey])}
                        />
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function TableHeader({ column, currentSortKey, direction, onSort, isPending }) {
    const { header, sortKey, sortable = true } = column;
    
    if (!sortable || !sortKey) {
        return <th className={styles.header}>{header}</th>;
    }
    
    const isCurrentSort = currentSortKey === sortKey;
    
    return (
        <th 
            className={`${styles.sortableHeader} ${isPending ? styles.isPending : ''}`}
            onClick={() => onSort(sortKey)} 
            aria-label={`Sort by ${header}`}
            role="button"
        >
            {header}
            {isCurrentSort ? (
                direction === 'asc' ? 
                <span className={styles.sortIcon}>
                    <FontAwesomeIcon icon="fa-solid fa-chevron-down" widthAuto size="xs"/>
                </span> :
                <span className={styles.sortIcon}>
                    <FontAwesomeIcon icon="fa-solid fa-chevron-up" widthAuto size="xs"/>
                </span>
            ) : (
                <span className={`${styles.sortIcon} ${styles.hiddenIcon}`}>
                    <FontAwesomeIcon icon="fa-solid fa-chevron-down" widthAuto size="xs"/>
                </span>
            )}
        </th>
    );
}

function TableRow({ data, columns, onRowClick, isHighlighted }) {
    const handleClick = useCallback(() => {
        if (onRowClick) {
            onRowClick(data);
        }
    }, [data, onRowClick]);
    
    return (
        <tr 
            className={`${styles.row} ${onRowClick ? styles.clickableRow : ''} ${isHighlighted ? styles.highlightedRow : ''}`} 
            onClick={onRowClick ? handleClick : undefined}
        >
            {columns.map((column) => (
                <TableCell 
                    key={column.key || column.header}
                    data={data}
                    column={column}
                />
            ))}
        </tr>
    );
}

function TableCell({ data, column }) {
    const { key, render, dataKey } = column;
    
    // If custom render function is provided, use it
    if (render) {
        return <td className={styles.cell}>{render(data)}</td>;
    }
    
    // Otherwise use the dataKey to get the value
    const value = dataKey ? data[dataKey] : data[key];
    
    return <td className={styles.cell}>{value}</td>;
}
