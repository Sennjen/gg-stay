# Learning the store pages of more games, inside a request budget

Date: 2026-10-13. Status: built as described here. Widening the index, which this prepares for, is not part of it and has no design yet.

## Why

The price index holds the 3 000 most popular games — the top of RAWG's most-added order, 75 pages of 40 — and the games of the listed Ukrainian studios. To price a game the job has to know which product it is in each store: its Steam app id, its GOG page, its Microsoft Store product. RAWG has all of that in one answer, `games/{slug}/stores`, and gives it one game a request.

RAWG's free plan is 20 000 requests a period. The period that ends on 2026-10-18 has about 6 000 of them left that nothing will use. What a lookup learns is kept for the life of the index, outside any version (`appid:{rawgId}`, `storeref:{rawgId}`), so it can be learned before it is needed: spent now on the games below the 3 000, those requests mean that an index widened later asks RAWG nothing for the games it gains.

So this change adds no game to the index and no price to a page. It adds a way to spend a stated number of RAWG requests on what a wider index will need, and it has to be safe to run against production on the day it merges.

## What

### 1. A fourth mode of the refresh job: `resolve`

`pnpm index:refresh --mode=resolve`, run by hand through the workflow's form. No schedule selects it. Three numbers, all whole, read from the environment and checked by the script:

- `budget` — the most RAWG requests the run may send. Required: the run does not start without one, or with one above `RESOLVE_MAX_BUDGET = 8000`.
- `from_page` — the first page of the most-added order to read. 76 when blank: pages 1 to 75 are the nightly run's.
- `pages` — the most pages to read from there. 250 when blank.

The first two are a resolve run's alone, and the job fails closed on them: any other mode given a budget or a first page refuses to start, so a mode chosen by mistake in the form spends nothing. Scheduled runs pass every input empty.

### 2. Who is asked

The run reads the order page by page with the query the nightly run's candidates use — the same ordering and the same page size, by the same function — and asks about a game when all of this holds:

- **it is out**: RAWG's `released` is a day on or before the run's, and the game is not `tba`. A game with no date, a date to come or `tba` has no price to find yet, and no request is spent on it;
- **RAWG lists it on a store the job reads or is about to read**: Steam, GOG, the Xbox store or the PlayStation Store;
- **nothing is known about it**: it has neither an `appid:` entry, of any value, nor a `storeref:` record.

Most popular first: in the order of the pages, and of the games on a page. A game is counted under the first of the three rules that leaves it out.

### 3. The budget

The budget is a number of requests, of any kind, and it is counted where a request leaves for the network: a meter in the job's RAWG transport, called immediately before every `fetch`. That is the one place the transport's own retry of a timeout or a 5xx passes like a first attempt, and where an answer out of the transport's cache does not pass at all. A stage counting its own calls would see neither.

The run sets the budget as a limit on that meter before it asks anything, and the limit refuses a request that would be one too many before it is sent. So a budget of N sends N requests when there is more to do and never N + 1: when the last request is a lookup's first attempt and it fails, the retry it has earned is not sent, and the game waits for another run. Under a limit the transport follows no redirect either, because `fetch` would follow one by itself and that second request would be counted by RAWG and by nobody here; a redirect comes back as the answer it is and is a failed lookup.

Before it starts a page or a lookup the run looks at what is left, which is how it stops in good order rather than on a refusal.

**A page is read only while it can still be used.** A page costs a request, and its games stand behind every game of the pages before it. Once the games already waiting are as many as the requests left, another page could only take a request from one of them, so the reading stops there. A run given 100 requests and the default 250 pages reads the few pages whose games a hundred requests can cover and spends the rest on lookups; it does not spend the hundred on pages. The two mappings are consulted for this only when the count of games in hand could have reached the requests left — two reads of the index on a first run, not two a page.

### 4. What an answer leaves behind

Written in batches of a hundred, as the app-id stage writes:

- **a store-reference record, always**: the GOG page and the Microsoft Store product the links name, the mark "asked, and no link to read" for a store the game is listed on without one, and the links themselves (below). The record is what says a game has been asked about, so one is written even when it says nothing else;
- **the Steam app id**, when a link names one — and the empty app id, "this game has no Steam page", only for a game RAWG lists on Steam, which is all an empty entry has ever meant. Written for a game RAWG does not list there, it would be read by the nightly run as an answer for good, and the game would not be asked about on the day it comes to Steam. Such a game is known by its record instead.

A lookup that fails — a refusal, a failure past its retry, an answer that is no list of links — writes nothing, and the game is asked about by another run.

### 5. RAWG's links are kept with the record

`IndexedStoreRefs` gains `links?: [storeId, url][]`: every link RAWG gave for the game, as pairs of RAWG's store id and the URL, in RAWG's order. The PlayStation Store is the next store the job will read, and its reference can then be taken from what is already known instead of asking RAWG about every game again.

They are third-party text, partly publisher-submitted, and are treated as data and nothing else: never rendered, never written to a log or a summary, never followed. Only a reference parser reads them, by their shape. They are bounded where a record is made: absolute http(s) URLs only, kept as `URL` writes them, at most 300 characters each, a whole-number store id, and at most twelve a game; a link that fails a check is left out and the others are kept.

The app-id stage and the nightly sweep keep the links too when they ask, so every answer from now on carries them. Who is asked does not change: the links are no mark of any store, and `needsStoreLookup` reads the two store fields alone.

### 6. When it stops

Whichever comes first:

- the budget is spent;
- nobody is left to ask on the pages it read;
- RAWG is failing wholesale — the sweep's rule: past five failed lookups and a twentieth of those begun;
- sixty minutes have passed on the job's clock (`RESOLVE_BUDGET_MS`), reading and asking together.

The reading has ends of its own: the last page it was given, the end of RAWG's list, and a page RAWG fails after the transport's retry. A failed page ends the reading there — the run does not skip it, because the order would have a hole in it — and the run goes on to ask about the games of the pages before it.

RAWG cannot fail the run. Whatever it had learned when it stopped is written, because it is quota already spent. An entry of a list page that cannot be read as a game is skipped and counted, not a reason to stop. A lookup whose last attempt failed and whose retry the budget refused ends the run as the budget's doing, not as RAWG's. Only the index failing a read or a write, or a lock another run holds, ends it red.

### 7. It publishes nothing

No documents, no version, no pointer, no metadata. The run takes the writer's lock the way every run takes it, by beginning a version, renews it among the pages and with every batch, and gives it back by discarding that version unwritten — as a run that fails does. The published version, `idx:current` and the metadata are exactly as they were; the run draws one number from the version sequence, which the next publication skips, as it skips the number of any run that did not publish. The mappings are written under the lock a scheduled run would hold to write them.

A run with no usable budget is refused before the lock is asked for.

### 8. The summary

A table of its own, since nothing of a publication applies: pages read and why the reading ended; games seen; skipped, by reason; asked and failed; how many have a Steam page, a GOG page, a Microsoft Store product; RAWG requests sent against the budget, split into pages, lookups and retries; how many games were left unasked and the page the first of them is on; why it stopped; and where a follow-up run should begin — the page of the first game left unasked, else the page after the last one read — or that RAWG's list has ended. A warning annotation when it stopped because RAWG was failing, and when a page RAWG failed cut the reading short: the run is green either way, and the annotation is on the run's page for whoever does not open the summary.

## Not in this change

- **Widening the index.** No game is added to it, no document changes, and the nightly run's 75 pages stay 75. What the index should hold beyond the 3 000, how its checks and its store's free tier take that, and what the site says about its coverage is a design of its own.
- **Reading the PlayStation Store.** The links are kept for it; nothing parses them yet and no record has a PlayStation field.
- **Links for the games already resolved.** Records written before this change have none. They get them when a game is next asked about, which for most of them is never; a store read later will have to ask about those games once.
- **A schedule.** The mode exists to spend quota that would otherwise lapse. Whether it should ever run by itself depends on what the index becomes.
- **Answers with no links at all.** A game RAWG lists on a store and answers for with an empty list of links is remembered as it is — the empty app id for a Steam game, a record without links — as the nightly stages remember it, and the summary does not count such answers apart; a RAWG that answered empty lists for a while would leave such games marked for good, and the records without links are how they would be found again.
- **A cancelled run.** A run cancelled or killed loses the batch it had not written (up to a hundred answers) and holds the lock until it lapses, half an hour later, as a run of any mode does; there is no handler that writes on a signal.
- **A ledger across runs.** The budget belongs to one run. A second dispatch, or "Re-run jobs" on a finished run, spends a budget of its own; nothing counts what earlier runs spent.

## Constraints

- The job's transport to RAWG is unchanged for the three scheduled modes: no limit is set, so nothing is refused and redirects are followed as before. The meter counts in every mode and only `resolve` reads it.
- In fixture mode there is no network to count at, so a recorded answer counts as the request it stands for: a dry run spends a budget the way a live one does.
- Nothing the site reads is written. `appid:` and `storeref:` are read by the job alone.
- English only, no secret and no raw upstream text in the log; the numbers from the workflow's form are never written into a command line. An error from the index's client that quotes the request it failed on is cut there before it is printed, so no batch of records — links and all — reaches the log or the summary.

## After the merge

- A first run with a small budget shows the mode working against production before the quota is committed: `budget=100` reads a few pages and asks about the games on them with what is left.
- A follow-up run should begin at the page the summary names for the first game left unasked. Begun again at 76, it reads every page the first run finished with before it reaches a game it can ask about, at a request a page.
- 6 000 requests take 25 minutes at the limiter's four a second, and about 50 at the slower end of the pace the sweep's note gives for RAWG (five to ten minutes for 1 200 lookups). A RAWG slower than 0.6 s a request does not get through them in the sixty minutes the run has, and the run then stops with part of its budget unspent.
- No request was made to RAWG while this was built, so reading this far down the order is untried: if RAWG refuses a page, the reading ends there and the run says so in its summary and in an annotation.
