const dayjs = require("dayjs");

module.exports = class YDate {

    constructor(date) {
        this._date = date;
    }

    static parse(str) {
        const date = dayjs(str);
        if ( !date.isValid() ) return null;
        if ( date.format("YYYY-MM-DD") != str ) return null;

        return new this(date);
    }

    end_of_month() {
        return new this(this._date.endOf('month'));
    }
    start_of_month() {
        return new this(this._date.startOf('month'));
    }

    toString() {
        return this._date.format("YYYY-MM-DD");
    }
    toJSON() {
        return this._date.format("YYYY-MM-DD");
    }
}
