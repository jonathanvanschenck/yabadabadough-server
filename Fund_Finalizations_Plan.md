# Finalizations
Finalizations exists to do 3 main things: (1) cache sonm_balences so that recalculating fund balences have a cached point
to calculate against rather than having to always start from the start of the fund (2) indicate that all transactions
have been accounted for in the system (3) to historically track surplus/loss in monthly-type funds (which zero-out at the
start of each month).

## Month Finalizations
A month can be "finalized" (triggered by the user, *not* automatically) meaning that all the tracked funds in the month are finalized.
At finalization time, if any tracked funds are of type "monthly" a new transaction group should also be inserted with the
"eom_cleanup" flag set so that all of the eom_cleanup transactions can stay bundled.


## Fund Finalizations
When a fund is finalized, its end-of-month balence is cached -- then if it is a "monthly" type fund a new transaction is added
to zeros the fund out (this "eom_cleanup" transaction should be part of the single "eom_cleanup" transaction
group for the month's finalization). Then all funds have their balences cacluated up to the end of the month (including
eom_clenaup transactions if they exist). This value is then saved as the "sonm_balence". 


## Unfinalizations
Once a month has been finalized, no more transactions/transaction groups for in that month (or any previous)
month may be added. So, to add a new transaction/TG in a previously finalized month, the month must first be unfinalized.

Unfinalization should basically do the reverse of a fund finalization -- removeing the fund/month_finalization rows

## Fund balance calculation
As part of this feature -- I want to remove "balance" as a value that gets tracked in the funds table. Rather, Users
should query for the balance on a certain date (or calculate it themselves). To this end, we should standardize the "cache"
value in fund api to fallback to the "starting" values when no funds have been finalized, so that callers always have
one place to look up information. (Note, I like the idea of making the fallback logic also back date the "cache_date"
to the start of the month when the fund was started, so that the cache date is *always* a first of the month).

Additionally, we should add methods to the Fund object to make querying for fund finalizations easy for users. E.g. "get the cached
valued for the fund balance immeidately before provided date" which is equivalently "Forward Balence for month X". This
should use the same fallback logic as described above. Another workflow we want to support is looking up the finalizations
for a montly fund to track surplus/loss via the eom_balance.

## Edge cases and subtlies
- If a user attempts to finalize a month and previous months (where funds exist) have not been finalized, those previous months
    should be finalized too. (We want both workflows: (1) throws error if previous months are not finalized and (2) automatically
    recursively finalizes months if necessary).
- Users shoud not be directly finalizing/unfinalizing funds, they should work on months as a whole, in the same way a user should
    never add a raw transaction directly, but only a transaction group.
- If a new tracked fund is created with a start date that preceeds a finalized month, at fund creation time the fund should
    internally have all necessary fund finalizations added to make the fund's finalization point match every other fund.
- A fund may not be converted between `monthly` and `not monthly` without unfinalizing back to the start of that fund,
    and then re-finalizing back up to the present


### Date subtlies
For the purpose of calculating a fund's "balence" the User can provide a date, and get back the fund's balence "on that date"
meaning including every transaction up to and on that date. This is somewhat distinct from what get's called a 'balence' in
the db:
    - `funds.starting_balence` is the fund's balence ENTERING the start_date, but not including any trnasactions on that date.
    - `funds.balance` is the current balance of the account including every transaction. It has no specific date, but implies a
        validaty time range including and after the final transaction for a fund.
    - `fund_finalizations.eom_balance` is the fund's balence *leaving* a month, but not including a eom_cleanup transaction if
        relevant.
    - `fund_finalizations.sonm_balance` is the fund's balence *enter* next month (including eom_cleanup transactions). Note
        that using the above definition of a "balance on date" sonm_balance is technically the "balance on the last day of
        this month"
    - Over the api, the "cached_balance" is similarly a "forward balence" meaning it doesn't include any transactions for the
        referenced date.


We should consider renaming these entities on the api e.g. "cached_balance" to something like "cached_forward_balance" for
clarity
