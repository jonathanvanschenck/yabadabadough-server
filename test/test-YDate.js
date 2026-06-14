
const { expect } = require("chai");
const YDate = require("../lib/YDate.js");

describe("lib/YDate.js", () => {

    it("Can parse valid dates", () => {
        const input = "2026-01-01";
        const ydate = YDate.parse(input);
        expect(ydate).to.not.equal(null);
        expect(ydate.toString()).to.equal(input);
    });

    it("Fails to parse non-dates", () => {
        const input = "bad";
        const ydate = YDate.parse(input);
        expect(ydate).to.equal(null);
    });

    it("Fails to parse date-like nonsense", () => {
        const input = "2026-02-29"; // not a real date
        const ydate = YDate.parse(input);
        expect(ydate).to.equal(null);
    });

    it("Handles leap year", () => {
        const input = "2024-02-29";
        const ydate = YDate.parse(input);
        expect(ydate).to.not.equal(null);
        expect(ydate.toString()).to.equal(input);
    });
});
