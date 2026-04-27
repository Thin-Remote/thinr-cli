# Backend perf bug — `GET /v{1,2}/users/{user}/buckets/{bucket}/data` with `group_by`

## TL;DR

The "latest sample per device" query (`group_by=device`, no time range, multiple `fields`) scales **linearly with the number of requested fields** and hits the 10-second gateway timeout at five fields. Root cause is a `$sort + $group/$first` pattern that sorts the **entire bucket history** before grouping. The same shape works fine when a time range is supplied. Recommended fix: replace `$sort + $group/$first` with `$group { $top: { sortBy: { ts: -1 }, output: "$$ROOT" } }` (Mongo 5.2+).

A second, smaller issue lives in the no-`group_by` branch: the same query without `group_by`, with a 10-minute window, also times out — likely the `find()` with `sort: {ts: -1}` is not using a covering index. Worth a separate look.

---

## Reproduction

Against a real bucket with ~99 active devices reporting every minute, on `thinger.thinr.io`:

### Linear scaling with `fields` (group_by=device, no time range)

```
items=1, no group_by, no fields                  →  rows=1    time=  797ms
items=1, group_by=device, no fields              →  rows=110  time= 1550ms
items=1, group_by=device, fields=cpu.usage       →  rows=110  time= 4995ms
items=1, group_by=device, fields=cpu+mem         →  rows=110  time= 6659ms
items=1, group_by=device, fields=cpu+mem+disk    →  rows=110  time= 8639ms
items=1, group_by=device, +uptime                →  rows=110  time= 9871ms
items=1, group_by=device, +agent.version         →  ERROR    10003ms (timeout)
```

Each additional field adds ~1.5–2 s. `items` does NOT change the cost (items=1 and items=500 behave the same), so the work isn't proportional to documents *returned* — it's proportional to documents *processed*.

### Adding a time range fixes it

```
5 fields, no time range                          →  ERROR  10021ms
5 fields, last 60 min                            →  609ms
5 fields, last 10 min                            →  202ms
5 fields, last  5 min                            →  197ms
1 field,  last  5 min                            →  107ms
```

50× speedup with a 5-minute window. With 110 devices publishing every minute, the windowed dataset is tiny.

### Aggregated path is unaffected

Same `group_by=device` but with an aggregation function takes a **different code path** in `mongodb_bucket::get_data` (the `$dateTrunc` branch, line 851 onward) and is fast even over wide windows:

```
group_by=device, agg=1m  avg, 30 min   →  rows=2957 (99 devs)  time=903ms
group_by=device, agg=10m avg, 1 hour   →  rows= 693 (99 devs)  time=239ms
group_by=device, agg=10m avg, 6 hours  →  rows=3661 (99 devs)  time=774ms
group_by=device, agg=30m avg, 12 hours →  rows=2475 (99 devs)  time=1544ms
```

Confirms the issue is specific to the **`$sort + $first` pattern** used when `aggregation_type` is empty.

---

## Root cause

File: `backend/src/thinger/buckets/storage/mongodb/mongodb_bucket.cpp`
Function: `mongodb_bucket::get_data` (lines 738–1015)

When `group_by` is set without `aggregation_type`, the pipeline assembles like this:

1. `$match` — filters by user/bucket/timestamp range.
   - Built by `match_doc` (line 164). **If `min_ts` and `max_ts` are 0, the filter is empty** (lines 173–176), so it matches the entire bucket collection — potentially millions of documents going back the bucket's full retention.
2. `$project` — keep only requested fields, with normalized names (lines 791–805).
3. `$match` — `{field: {$ne: null}}` per requested field (lines 808–817).
4. **`$sort` by `ts` desc** (lines 833–839) — *this is the killer*. It sorts the entire match output before grouping, so it can pick the latest doc per group with `$first`.
5. `$group` — `_id: { device }`, with `ts: { $first: "$ts" }` and `field_n: { $first: "$field_n" }` for each field (lines 883–889).
6. `$project` — restore original field names (lines 919–960).
7. `$sort` again by `ts` desc.

Why the linear scaling with `fields`:

- The `$project` at step 2 keeps each requested field in the document going into the sort.
- The `$sort` at step 4 has to materialize each pre-group document in memory and order it.
- More fields → larger documents → larger working set in `$sort` → eventually spills to disk (default in-memory sort limit is 100 MB) → quadratic-ish slowdown until the timeout trips.

The `$ne: null` per-field match doesn't help much because most rows have all fields. It's an extra pass on the same dataset.

The aggregated path (when `aggregation_type` is set) takes a different branch (line 851) that uses `$dateTrunc` to time-bucket directly in `$group`, with **no pre-group sort** — which is why aggregated queries with much wider time windows are still fast.

---

## Recommended fix

### 1. Replace `$sort + $group/$first` with `$group + $top` (preferred)

Mongo 5.2 added the `$top` accumulator, which returns the document with the maximum `sortBy` value per group **without requiring a pre-sort**. The optimizer can then push the sort criteria down to indexes when available.

Replace the block currently around lines 833–906 (`agg_type.empty() && !params.group_by.empty()` branch) with something like:

```cpp
// No aggregation, just grouping: use $top to take the latest doc per
// group based on ts, without a pre-group $sort over the whole match.
nlohmann::json group;
group["_id"] = nlohmann::json::object();
for (const auto& [normalized, original] : normalized_group_by) {
    group["_id"][original] = "$" + normalized;
}
nlohmann::json output = nlohmann::json::object();
output["ts"] = "$ts";
for (const auto& [field, source_field] : normalized_fields) {
    output[field] = "$" + field;
}
group["latest"] = {
    {"$top", {
        {"sortBy", {{"ts", params.descending ? -1 : 1}}},
        {"output", output}
    }}
};
pipeline.group(bsoncxx::from_json(group.dump()));

// Hoist the fields back to the top level so the rest of the pipeline
// (the final $project that restores original names) doesn't need to
// know about `latest.*`.
nlohmann::json hoist = {
    {"_id", 1},
    {"ts", "$latest.ts"}
};
for (const auto& [field, source_field] : normalized_fields) {
    hoist[field] = "$latest." + field;
}
pipeline.add_fields(bsoncxx::from_json(hoist.dump()));
```

Then SKIP the pre-group sort (lines 835–839) entirely in this branch — `$top` handles it internally.

The existing final `$project` (lines 919–960) should keep working unchanged because the hoist step puts fields where it expects them.

### 2. Default to a sensible time range when none is supplied

Belt-and-braces protection so the same shape can't kill the server in the future:

In `match_doc` (line 164) or in the request parsing, if `group_by` is set and neither `min_ts` nor `max_ts` was supplied, default `min_ts = now - 24h` (or whatever the bucket's `latest_window` is configured for). Document this default in the API spec.

The CLI mitigation (passing `minutes: 5` always) covers our case, but other consumers — ESP devices, integrations, ad-hoc curl from ops — won't.

### 3. Verify the index covers `(user_id, ts)`

The collection name presumably encodes user/bucket so the user filter is implicit. The `ts`-only sort still needs an index on `ts` (descending), which probably exists. Worth verifying it's used post-fix:

```js
db.bucket_<user>_monitoring.aggregate([...], { explain: true })
```

Check that the executionStats path uses an `IXSCAN`, not `COLLSCAN`, after the fix.

### 4. Bonus: the no-`group_by` find branch is also slow

Empirical:

```
no group_by, last 10 min, fields=cpu.usage                 → ERROR 10020ms
no group_by, last 10 min, fields=cpu+mem+disk              → ERROR 10004ms
no group_by, last 30 min, fields=cpu+mem+disk              → ERROR 10003ms
```

This goes through the `find()` branch (line 982–1013): a regular query with a `ts` range filter, sort by `ts: -1`, projection, and limit (e.g. 2000). Should be index-driven and trivially fast — yet it times out. Same suspicion: the index on `ts` exists but the query plan isn't using it (perhaps because of the projection or the sort direction). Worth running an explain on a real query and confirming.

This wasn't in scope for our dashboard fix — we worked around it by using the aggregation path for history pre-fill — but it would make raw historical queries usable from external tools.

---

## Client-side mitigations applied

For reference, in the CLI dashboard (`cli/src/dashboard/hooks/useFleetMonitoringStream.js`):

- The "snapshot" baseline now passes `minutes: 5`. Goes from 10 s timeout to ~210 ms.
- A second "history" baseline uses the aggregated path (`agg: '1m'`, `agg_type: 'avg'`, `minutes: 40`, `group_by: 'device'`, `fields: 'cpu.usage'`) to pre-fill per-device CPU sparklines on dashboard open. ~770 ms for 99 devices and ~3900 rows.

Both calls are cheap with the current backend, so there's no urgency on the server side from the dashboard's perspective. The fix is still worth doing for any other consumer of this endpoint that doesn't think to add a time range — and to remove the surprise factor when a five-field query suddenly stops working.

---

## Empirical raw data (full)

```
== Linear scaling with fields ==
items=1, group_by=device, fields=cpu.usage                 → 4995ms (rows=110)
items=1, group_by=device, fields=cpu+mem                   → 6659ms (rows=110)
items=1, group_by=device, fields=cpu+mem+disk              → 8639ms (rows=110)
items=1, group_by=device, fields=cpu+mem+disk+uptime       → 9871ms (rows=110)
items=1, group_by=device, fields=cpu+mem+disk+up+agent.v   → ERROR 10003ms

== items doesn't matter ==
items=  1, group_by=device, fields=5-fields                → ERROR 10022ms
items= 50, group_by=device, fields=5-fields                → ERROR 10003ms
items=100, group_by=device, fields=5-fields                → ERROR 10005ms
items=200, group_by=device, fields=5-fields                → ERROR 10004ms
items=500, group_by=device, fields=5-fields                → ERROR 10022ms

== Time range fixes it ==
group_by=device, fields=5-fields, no time range            → ERROR 10021ms
group_by=device, fields=5-fields, last 60 min              → 609ms (rows=99)
group_by=device, fields=5-fields, last 10 min              → 202ms (rows=99)
group_by=device, fields=5-fields, last  5 min              → 197ms (rows=99)
group_by=device, fields=cpu.usage, last 5 min              → 107ms (rows=99)

== Aggregated path is fast at any window ==
group_by=device, agg=1m  avg, 30 min,  fields=cpu/mem/disk → 903ms  (rows=2957)
group_by=device, agg=5m  avg, 60 min,  fields=cpu/mem/disk → 321ms  (rows=1287)
group_by=device, agg=10m avg, 1 hour,  fields=cpu/mem/disk → 239ms  (rows= 693)
group_by=device, agg=10m avg, 6 hours, fields=cpu/mem/disk → 774ms  (rows=3661)
group_by=device, agg=30m avg, 12 hours,fields=cpu/mem/disk → 1544ms (rows=2475)

== No group_by branch also slow ==
no group_by, last 10 min, fields=cpu.usage                 → ERROR 10020ms
no group_by, last 10 min, fields=cpu/mem/disk              → ERROR 10004ms
no group_by, last 30 min, fields=cpu/mem/disk              → ERROR 10003ms

== Sanity ==
no group_by, no fields, items=1                            → 797ms (rows=1)
no group_by, no fields, items=10                           → 510ms (rows=10)
group_by=device, no fields                                 → 1550ms (rows=110)
```

Tested 2026-04-27 against `thinger.thinr.io`, `monitoring` bucket on user `monitoring`.
