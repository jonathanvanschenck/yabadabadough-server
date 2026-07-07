
const YDate = require("../../lib/YDate.js");

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

// Strict parsers for request BODIES: no string coercion (unlike the to_*
// parsers, which exist to coerce query strings). They signal failure by
// returning the fallback (default undefined), which is what
// parse_body_fields keys off of.
function only_int(integer, fallback=undefined) {
    if ( !Number.isInteger(integer) ) return fallback;
    return integer;
}
function only_id(integer, fallback=undefined) {
    if ( !Number.isInteger(integer) || integer <= 0 ) return fallback;
    return integer;
}
function only_number(number, fallback=undefined) {
    if ( typeof(number) != "number" || isNaN(number) ) return fallback;
    return number;
}
function only_positive_number(number, fallback=undefined) {
    if ( typeof(number) != "number" || isNaN(number) || number <= 0 ) return fallback;
    return number;
}

// Strict YYYY-MM-DD -> YDate (YDate.parse validates the exact format);
// works for bodies and query params alike
function only_ydate(str, fallback=undefined) {
    if ( typeof(str) != "string" ) return fallback;
    return YDate.parse(str) ?? fallback;
}
const to_ydate = only_ydate; // naming symmetry at query-param call sites

// Combinator: passes null through untouched, otherwise applies `parser` --
// for nullable body fields, instead of `(v) => v===null ? v : only_string(v)`
function nullable(parser) {
    return (value, fallback=undefined) => value === null ? null : parser(value, fallback);
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
    only_int,
    only_id,
    only_number,
    only_positive_number,
    only_ydate,
    to_ydate,
    nullable,
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

