module.exports = {

    to_positive_int: (value, fallback) => {
        const retval = parseInt(value);
        return isNaN(retval) || retval < 1 ? fallback : retval
    },

    only_string: (value, fallback) => {
        if ( typeof(value) !== 'string' ) return fallback;
        return value;
    },

    only_nonempty_string: (value, fallback) => {
        if ( typeof(value) !== 'string' || value.length == 0 ) return fallback;
        return value;
    }
}
