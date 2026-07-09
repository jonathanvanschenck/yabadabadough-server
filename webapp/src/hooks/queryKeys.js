/**
 * Re-export of the SERVER's tanstack-query key registry -- the single source
 * of truth shared by both sides. The keys we cache under here are exactly
 * the keys the server's write responses and socket broadcasts invalidate,
 * so they can never drift. See the registry itself for the key conventions
 * (plural list keys, singular + stringified-id single keys, computed
 * subresources under their own top-level key).
 *
 * The registry lives outside the webapp (it is also require()d by the
 * server), which is why this shim exists: everything in src/ imports QK
 * from here, keeping the reach-out-of-tree path in one place.
 */
export { QK } from '../../../collections/lib/query_keys.mjs';
