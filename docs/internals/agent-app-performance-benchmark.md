# Public agent-app performance benchmark

T3 Code implements an app-owned driver for the public
[Agent App Benchmark](https://github.com/kyashrathore/agent-app-benchmark). The benchmark framework,
schemas, OpenCode event corpus, resource monitor, result corpus, and comparison website live in that
repository. T3 owns only the translation into its production projection schema and the UI automation
needed to declare its native readiness endpoint.

The benchmark measures completed historical GUI sessions. It does not run an agent, stream output,
exercise a terminal, or measure Web Vitals. The driver serves two scenarios: `app-start`
(new and initialized application state) and `session-switch-walk` (a walk down the session list
plus a progressive 1/8 MiB memory workload), and the same two flows over a private real-session
corpus as `app-start-real-sessions` and `session-switch-walk-real-sessions`. The framework
owns their cases, external process-family RSS sampling, and public result derivation.

## T3 adapter flow

1. `t3-public-materializer.ts` reads the pinned OpenCode NDJSON stream in sequence, verifies each file
   digest and transcript byte count, translates it into `ProjectionFixture`, writes through
   `writeProjectionFixture()`, and reads the database back before returning a mapping receipt.
2. `t3.ts` seals `P0` after materialization. T3 has never launched that state.
3. It clones `P0`, performs one unmeasured launch to the common control-session endpoint, shuts down
   cleanly, and seals the result as `P1`.
4. Every measured attempt clones the requested sealed state. The driver returns only application root
   process identities; the shared runner observes the complete process family.
5. Session-switch timing begins at a trusted pointerdown on the destination's session-list row and
   ends at the settle of the framework's page clock (`settleExpression` from
   `agent-app-benchmark/driver-sdk`, rule `settle-31-frames`): the first frame of the first run of 31
   frames in which every ready gate holds and the transcript's geometry and rows neither change nor
   mutate. The framework computes the gates, the signature, and the settle; the driver arms the clock
   before its click and supplies only T3's facts (`t3SessionFacts`):
   - displayed: the chat root whose `data-chat-owner-thread-key` ends in the destination's thread id
     is shown and holds no `data-thread-sync-drawer`;
   - transcript: the nearest scrolling ancestor of that root's `data-timeline-root`;
   - rows: the transcript's `data-timeline-row-id` elements, keyed by that id;
   - latest turn: the rows whose `data-message-id` is one of the destination's latest-turn message
     ids, top to bottom;
   - composer: the root's `composer-editor` with `contenteditable="true"`;
   - placeholder: a `data-slot="skeleton"` inside the transcript.

   App start measures the same settle after launch's click on the control session's row, from the
   process spawn on the driver's clock; the renderer's frames map onto it by the difference of the
   two clocks' time origins. Each measured activation returns the frames it was derived from so the
   framework can re-derive it.

A list-walk step measures one activation of the row directly below the previous destination; the
first pass opens each session for the first time in that app process and the second pass returns to
each in the same order. A progressive-resource step first activates the control session unmeasured
and then measures the destination's first activation; the workload ends with a return to control
bounded by a 5 s readiness ceiling. The driver reports one raw duration per activation; averages,
maximums, p95, memory, trends, and the website are framework-owned.

## Running

Build the production desktop bundle first. Then, from a checkout of the public framework:

```bash
T3_ROOT=/absolute/path/to/t3code \
T3_BENCHMARK_EXECUTABLE="/absolute/path/to/T3 Code (Alpha).app/Contents/MacOS/T3 Code (Alpha)" \
node bin/agent-app-benchmark.mjs run --app t3 --output /absolute/path/to/run-output
```

The run prepares the corpus once, runs app start and then the list walk, and writes one result per
scenario. The driver creates disposable state only below the framework-provided run directory and
never reads or writes the user's live `T3CODE_HOME`. The packaged app must be built from this
checkout's HEAD, or from an ancestor that differs from it only in the driver and this document.
