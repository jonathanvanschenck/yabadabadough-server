
function only_string(str, fallback=undefined) {
    if ( typeof(str) != "string" ) return fallback;
    return str;
}
function only_non_empty_string(str, fallback=undefined) {
    if ( typeof(str) != "string" || str.length == 0 ) return fallback;
    return str;
}
function to_int(integer, fallback=undefined) {
    const out = parseInt(integer);
    if ( isNaN(out) ) return fallback;
    return out;
}
function to_positive_int(integer, fallback=undefined) {
    const out = parseInt(integer);
    if ( isNaN(out) || out <= 0) return fallback;
    return out;
}
function to_non_negative_int(integer, fallback=undefined) {
    const out = parseInt(integer);
    if ( isNaN(out) || out < 0) return fallback;
    return out;
}
function to_float(number, fallback=undefined) {
    const out = parseFloat(number);
    if ( isNaN(out) ) return fallback;
    return out;
}
function to_positive_float(number, fallback=undefined) {
    const out = parseFloat(number);
    if ( isNaN(out) || out <= 0 ) return fallback;
    return out;
}
function to_non_negative_float(number, fallback=undefined) {
    const out = parseFloat(number);
    if ( isNaN(out) || out < 0 ) return fallback;
    return out;
}
function only_boolean(bool, fallback=undefined) {
    if ( typeof(bool) == "boolean" ) return bool;
    return fallback;
}
function string_to_boolean(string, fallback=undefined) {
    switch (string) {
        case true:
        case "true":
        case "True":
        case "T":
        case "t":
        case 1:
        case "1":
            return true;
        case false:
        case "false":
        case "False":
        case "F":
        case "f":
        case 0:
        case "0":
            return false;
        default:
            return fallback;
    }
}

function to_date(date, fallback=undefined) {
    const d = new Date(date);
    if ( isNaN(d) ) return fallback;
    return d;
}

function string_to_enum(proposal, valids=[], fallback_not_string=undefined, fallback_not_present=undefined) {
    if ( typeof(proposal) != "string" ) return fallback_not_string;
    if ( valids.includes(proposal) ) return proposal;
    return fallback_not_present;
}

function only_direction(string, fallback=undefined) {
    switch (string) {
        case "a":
        case "asc":
        case "ASC":
            return "ASC";
        case "d":
        case "desc":
        case "des":
        case "DESC":
        case "DES":
            return "DESC";
        default:
            return fallback;
    }
}

function string_to_array(string, split=",", fallback=undefined) {
    if ( typeof(string) != "string" ) return fallback;
    return string.split(split);
}

function parse_and_filter_array(arr, parse, filter=(x) => x!==undefined, fallback=undefined, empty_fallback=[]) {
    if ( !Array.isArray(arr) ) return fallback;
    const filtered_arr = arr.map(parse).filter(filter);
    if ( filtered_arr.length == 0 ) return empty_fallback;
    return filtered_arr;
}

module.exports = {
    only_string,
    only_non_empty_string,
    to_int,
    to_positive_int,
    to_non_negative_int,
    only_boolean,
    to_positive_float,
    to_non_negative_float,
    to_float,
    string_to_boolean,
    to_date,
    string_to_enum,
    only_direction,
    string_to_array,
    parse_and_filter_array
};

