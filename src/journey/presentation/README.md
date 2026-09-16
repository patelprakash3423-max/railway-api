# Journey Result Quality & Presentation V1

Pure, synchronous processing of serialized final results. No provider, database,
clock, random source, or recovery imports. Input order becomes one-based engineRank;
the returned array is in one-based displayRank order. Input objects are not mutated.

Comparison is lexicographic: status tier (full, split class, recovery, scheduled,
incomplete), descending existing coverage, descending inventory quality, ascending
self-managed distance, train changes, class changes, duration, connection penalty,
distance, complete fare, engineRank. Complete known fares precede partial/unknown
fares only at the fare criterion; partial fares are never treated as total fares.

Inventory quality = clamp((sum AVAILABLE segment km + 0.8 × sum RAC segment km)
/ totalDistanceKm, 0, 1). Use normalized segment distances; missing/nonfinite or
negative distances contribute zero. A zero journey distance scores zero.
SELF_MANAGED, unchecked inventory and WAITLIST contribute zero. Coverage is never
recomputed. Connection penalty preserves Planner V2 semantics: GOOD=0, TIGHT=1,
LONG=2, summed across connections; no transfer feasibility is recalculated.

Signature is a JSON tuple [origin, destination, departure date, ordered train
numbers, ordered interchange stations]. JSON avoids delimiter collisions; endpoint
and date context avoids combining different journeys. Classes are excluded.
variantGroupId is the signature itself. The best ranked variant is primary;
alternates retain their own status, group, rank and data, and are never discarded.

The first result alone gets BEST_OPTION if full/split/recovery, otherwise
BEST_SCHEDULED_OPTION. Other badges each have one winner among usable/recovery
primary routes: FASTEST by duration, CHEAPEST by complete known total fare,
FEWEST_CHANGES by trainChanges, MOST_RESERVED by coverage then inventory quality.
Ties use displayRank. No eligible result means no badge; schedules never receive
these performance badges. Multiple distinct badges may legitimately share a winner.

Groups follow status and are supplied in display order. OTHER is always collapsed,
including schedule-only searches, which still expose a group count. The first five
usable/recovery primaries have initiallyVisible=true. Frontend expansion exposes
remaining primaries and alternates without a new search. Summary status counts refer
to primaries; totalJourneys and the existing API summary retain raw totals.
hiddenAlternativeCount counts all results not initially visible, including alternates
and collapsed OTHER cards. No timing diagnostics are included, preserving determinism.
