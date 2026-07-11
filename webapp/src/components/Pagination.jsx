import { TightIconButton } from './Buttons.jsx';
import { Selector } from './Inputs.jsx';
import styles from './Pagination.module.css';

/**
 * A generic, controlled pager: a page-size selector, an "X–Y of Z" range
 * readout, and prev/next controls with a page indicator. Purely
 * presentational -- it owns no data or queries; the parent holds `page`
 * (1-indexed) and `pageSize` state and reslices/refetches on the callbacks.
 *
 * Pages are 1-indexed. When `totalItems` shrinks below the current page
 * (e.g. a filter change), the readout clamps to the last page, but the parent
 * is responsible for clamping its own `page` state -- pass the clamped value
 * back in so the two never drift (`onPageChange` fires from the buttons only).
 */
export default function Pagination({
    page,
    pageSize,
    totalItems = 0,
    onPageChange,
    onPageSizeChange,
    pageSizeOptions = [ 10, 25, 50, 100 ],
    itemLabel = 'item',
    className = '',
}) {
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
    const currentPage = Math.min(Math.max(1, page), totalPages);
    const firstIndex = totalItems === 0 ? 0 : (currentPage - 1) * pageSize + 1;
    const lastIndex = Math.min(currentPage * pageSize, totalItems);

    const canPrev = currentPage > 1;
    const canNext = currentPage < totalPages;

    return (
        <div className={`${styles.pagination} ${className}`}>
            <div className={styles.pageSize}>
                <Selector
                    value={String(pageSize)}
                    optionKeys={pageSizeOptions.map(String)}
                    optionDisplayNames={pageSizeOptions.map(n => `${n} / page`)}
                    onChange={(v) => onPageSizeChange?.(Number(v))}
                    isFrozen={false}
                    allowNull={false}
                    inputTitle="Items per page"
                />
            </div>

            <div className={styles.range}>
                { totalItems === 0
                    ? `No ${itemLabel}s`
                    : `${firstIndex.toLocaleString()}–${lastIndex.toLocaleString()} of ${totalItems.toLocaleString()} ${itemLabel}${totalItems === 1 ? '' : 's'}`
                }
            </div>

            <div className={styles.nav}>
                <TightIconButton
                    icon="fa-angle-left"
                    ariaLabel="Previous page"
                    title="Previous page"
                    disabled={!canPrev}
                    onClick={() => canPrev && onPageChange?.(currentPage - 1)}
                />
                <span className={styles.pageLabel}>
                    Page <span className="tabular-nums">{currentPage.toLocaleString()}</span> of <span className="tabular-nums">{totalPages.toLocaleString()}</span>
                </span>
                <TightIconButton
                    icon="fa-angle-right"
                    ariaLabel="Next page"
                    title="Next page"
                    disabled={!canNext}
                    onClick={() => canNext && onPageChange?.(currentPage + 1)}
                />
            </div>
        </div>
    );
}
