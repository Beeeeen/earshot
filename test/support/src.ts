/**
 * Earshot test harness — loading `src/` under the declared runner.
 *
 * WHY THIS FILE EXISTS (this is a finding, not a preference)
 * ---------------------------------------------------------
 * package.json declares the runner as
 *
 *     node --test --experimental-strip-types test/*.test.ts
 *
 * That runner cannot import `src/` as `src/` is currently written. Two
 * independent reasons, both reproducible on the Node in this repo (v22.14.0):
 *
 *   1. `src/**` uses NodeNext `.js` specifiers (`import ... from './protected.js'`),
 *      which is correct for `tsc` output but not resolvable by type stripping:
 *      Node does not remap a `.js` specifier onto a `.ts` file. Importing
 *      `src/core/spoken.ts` fails with ERR_MODULE_NOT_FOUND for
 *      `src/core/protected.js`.
 *
 *   2. `src/domain/store.ts:49` uses a TypeScript parameter property
 *      (`constructor(readonly clock: Clock) {}`). Strip-only mode rejects it
 *      with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX; it needs
 *      `--experimental-transform-types`, which the declared runner does not pass.
 *
 * Only `src/core/protected.ts`, `src/core/clock.ts` and `src/core/tz.ts` — the
 * three modules with no relative imports — load under the runner unaided.
 *
 * The tests must run against the real `src/`, and `src/` belongs to another
 * agent, so the workaround lives here: we register `tsx`'s ESM hooks (already a
 * devDependency, esbuild-backed) before touching `src/`. tsx resolves `.js` to
 * `.ts` and compiles parameter properties. Nothing in `src/` is modified, and
 * the transform is semantics-preserving — it emits the same field assignment
 * `tsc` would.
 *
 * Everything below is a plain re-export so the suites read normally. Imports
 * are dynamic because the hooks must be registered before module resolution,
 * and static imports are resolved before any module body runs.
 */

import { register } from 'tsx/esm/api';

register();

const protectedMod = await import('../../src/core/protected.ts');
const spokenMod = await import('../../src/core/spoken.ts');
const resultMod = await import('../../src/core/result.ts');
const clockMod = await import('../../src/core/clock.ts');
const tzMod = await import('../../src/core/tz.ts');

const authzMod = await import('../../src/domain/authz.ts');
const seedMod = await import('../../src/domain/seed.ts');
const soloMod = await import('../../src/domain/solo.ts');
const storeMod = await import('../../src/domain/store.ts');
const adherenceMod = await import('../../src/domain/adherence.ts');

const envelopeMod = await import('../../src/protocol/envelope.ts');
const channelMod = await import('../../src/protocol/private-channel.ts');
const timingMod = await import('../../src/protocol/timing.ts');

const kitMod = await import('../../src/tools/kit.ts');
const toolsMod = await import('../../src/tools/index.ts');

// --- core/protected --------------------------------------------------------
export const {
    TAINT_PATTERN,
    protect,
    priv,
    sealed,
    isProtected,
    composePrivate,
    markerOf,
    RevealCapability,
    PRIVATE_CHANNEL_CAPABILITY,
    SOLO_WINDOW_CAPABILITY,
    revealToPrivateChannel,
    revealUnderSoloWindow,
    LeakError,
    assertNoTaint,
    assertNoTaintDeep
} = protectedMod;

// --- core/spoken -----------------------------------------------------------
export const { say, joinSpoken, countPhrase, clockTime, partOfDay } = spokenMod;

// --- core/result -----------------------------------------------------------
export const { result } = resultMod;

// --- core/clock ------------------------------------------------------------
export const { SystemClock, FixedClock, DEMO_INSTANT, resolveClock } = clockMod;

// --- core/tz ---------------------------------------------------------------
export const { localParts, offsetMs, fromLocal, startOfLocalDay, parseHHMM, addLocalDays, weekdayName } = tzMod;

// --- domain ----------------------------------------------------------------
export const { canReceivePrivate, canAsk, canReceiveSealed, viewersOf } = authzMod;
export const { MARGARET, SARAH, DANA, TOM, HOUSEHOLD_TZ, HISTORY_DAYS, seedHousehold } = seedMod;
export const {
    SOLO_WINDOW_MS,
    openSoloWindow,
    closeSoloWindow,
    activeSoloWindow,
    secondsRemaining,
    underSolo,
    SoloWindowExpired
} = soloMod;
export const { Store, nextId, resetIdCounter } = storeMod;
export const { sliceDoses, todaySlice, weekSlice, slotDoses, punctuality } = adherenceMod;

// --- protocol --------------------------------------------------------------
export const { EARSHOT_OUTPUT_SHAPE, toCallToolResult, spokenError } = envelopeMod;
export const { deliverPrivately, recordDenial, renderInbox } = channelMod;
export const { LATENCY_BUDGET_MS, LatencyRecorder, summarise, round, latency } = timingMod;

// --- tools -----------------------------------------------------------------
export const { defineTool, resolveSubject, SUBJECT_INPUT, refusal, humanGap } = kitMod;
export const {
    TOOLS,
    TOOL_NAMES,
    toolByName,
    checkAdherence,
    nextDose,
    logDose,
    reportSymptom,
    careSummary,
    whoCanSee,
    openSoloWindowTool,
    disclosureLedger
} = toolsMod;

// --- types (erased at runtime) ---------------------------------------------
export type { Protected, AnyProtected, Classification, ProtectedClass } from '../../src/core/protected.js';
export type { SpokenText, Speakable } from '../../src/core/spoken.js';
export type { ToolResult, PrivateField, PrivatePayload, SealedRef, SpokenData } from '../../src/core/result.js';
export type { Asker, Decision } from '../../src/domain/authz.js';
export type { Grant, LedgerEntry, Medication, PersonId, SoloWindow, DoseEvent } from '../../src/domain/types.js';
export type { EarshotTool, ToolCtx } from '../../src/tools/kit.js';
export type { ToolStats } from '../../src/protocol/timing.js';
