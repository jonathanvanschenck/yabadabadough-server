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
        return new this.constructor(this._date.endOf('month').startOf('day'));
    }

    start_of_month() {
        return new this.constructor(this._date.startOf('month').startOf('day'));
    }

    start_of_next_month() {
        return new this.constructor(this._date.startOf('month').add(1, 'month').startOf('day'));
    }

    offset_days(days) {
        // technically the 'startOf' is unnecessary, but we will impose
        //  it for extra safety. dayjs claims to increment the day counter
        //  rather than just adding 24 hours, but I want total control
        return new this.constructor(this._date.add(days, 'day').startOf('day'));
    }

    toString() {
        return this._date.format("YYYY-MM-DD");
    }
    toJSON() {
        return this._date.format("YYYY-MM-DD");
    }
}
