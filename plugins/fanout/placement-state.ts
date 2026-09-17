import { randomUUID } from "node:crypto";
import {
  ADVICE_LIFETIME_MS, EMPTY_SNAPSHOT, REFRESH_DEADLINE_MS, mergeMachineConfig,
  parsePlacementConfig, parseThresholdPercent, type HostRow, type PlacementConfig,
  type SelectionSnapshot, type Snapshot,
} from "./placement";

export const PLACEMENT_KEY = "placement";

type Collection = { snapshot: Snapshot; hosts: HostRow[] };
type Collector = (config: PlacementConfig, signal?: AbortSignal) => Promise<Collection>;
type Clock = { wall: () => number; mono: () => number };

/** Copy observations into read-only facades; Object.freeze alone cannot freeze a Map. */
function readonlyMap<K, V>(source: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
  const map = new Map(source);
  const view: ReadonlyMap<K, V> = Object.freeze({
    get size() { return map.size; }, get: (key: K) => map.get(key),
    has: (key: K) => map.has(key), entries: () => map.entries(),
    keys: () => map.keys(), values: () => map.values(),
    [Symbol.iterator]: () => map[Symbol.iterator](),
    forEach: (callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown) =>
      map.forEach((value, key) => callback.call(thisArg, value, key, view)),
  });
  return view;
}

function readonlySet<T>(source: ReadonlySet<T>): ReadonlySet<T> {
  const set = new Set(source);
  const view: ReadonlySet<T> = Object.freeze({
    get size() { return set.size; }, has: (value: T) => set.has(value),
    entries: () => set.entries(), keys: () => set.keys(), values: () => set.values(),
    [Symbol.iterator]: () => set[Symbol.iterator](),
    forEach: (callback: (value: T, key: T, set: ReadonlySet<T>) => void, thisArg?: unknown) =>
      set.forEach(value => callback.call(thisArg, value, value, view)),
  });
  return view;
}

/** The only owner of committed configuration and observation publication. */
export class PlacementState {
  private tail: Promise<unknown> = Promise.resolve();
  private version = 0;
  private request = 0;
  private pendingThresholds = 0;
  private notifiedThreshold: number;
  private readonly session = randomUUID();
  private state: SelectionSnapshot;
  private stored: PlacementConfig;
  private readonly clock: Clock;

  constructor(
    config: PlacementConfig,
    threshold: number,
    private readonly persist: (config: PlacementConfig) => Promise<void>,
    clock: Clock = { wall: Date.now, mono: () => performance.now() },
  ) {
    this.clock = clock;
    this.stored = parsePlacementConfig(config);
    this.notifiedThreshold = parseThresholdPercent(threshold);
    this.state = Object.freeze({
      ...EMPTY_SNAPSHOT, machines: Object.freeze([]), threadHost: readonlyMap(new Map()),
      projectHosts: readonlyMap(new Map()), snapshotVersion: `${this.session}:0`,
      configRevision: 0, sampleRevision: 0, sampleConfigRevision: null,
      sampleStartedAt: null, sampleStartedMono: null,
      placementPolicy: this.stored.placementPolicy, thresholdPercent: this.notifiedThreshold,
      config: this.freezeConfig(this.stored.machines), pending: true, failure: null,
    });
  }

  get snapshot(): SelectionSnapshot { return this.state; }
  now(): number { return this.clock.mono(); }
  get config(): PlacementConfig { return parsePlacementConfig(this.stored); }

  private freezeConfig(config: PlacementConfig["machines"]): SelectionSnapshot["config"] {
    return Object.freeze(Object.fromEntries(Object.entries(config).map(([id, value]) => [id, Object.freeze({ ...value })])));
  }

  private publish(patch: Partial<SelectionSnapshot>): SelectionSnapshot {
    this.state = Object.freeze({ ...this.state, ...patch, snapshotVersion: `${this.session}:${++this.version}` });
    return this.state;
  }

  private serialize<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** Read/modify/write under the same boundary; failed storage writes publish nothing. */
  save(update: (current: PlacementConfig) => PlacementConfig): Promise<SelectionSnapshot> {
    return this.serialize(async () => {
      const next = parsePlacementConfig(update(this.config));
      await this.persist(next);
      this.stored = next;
      return this.publish({ config: this.freezeConfig(next.machines), placementPolicy: next.placementPolicy,
        configRevision: this.state.configRevision + 1, pending: true, failure: null });
    });
  }

  /** A notification already represents a persisted settings write. Never write it again. */
  thresholdChanged(raw: number | string | undefined): Promise<boolean> {
    const next = parseThresholdPercent(raw);
    if (next === this.notifiedThreshold) return Promise.resolve(false);
    this.notifiedThreshold = next;
    this.pendingThresholds++;
    // Synchronous invalidation barrier: a queued save must not delay suppression.
    // Only this owner publishes, and each publication is a synchronous atomic swap.
    this.publish({ pending: true });
    return this.serialize(() => {
      this.pendingThresholds--;
      if (next === this.state.thresholdPercent) return false;
      this.publish({ thresholdPercent: next, configRevision: this.state.configRevision + 1,
        pending: true, failure: null });
      return true;
    });
  }

  /** Requests supersede older collection, even when that collection finishes first. */
  async refresh(collect: Collector, signal?: AbortSignal): Promise<boolean> {
    const request = ++this.request;
    const capture = await this.serialize(() => ({ config: this.config, revision: this.state.configRevision }));
    const startedAt = this.clock.wall();
    const startedMono = this.clock.mono();
    try {
      if (signal?.aborted) throw new Error("refresh aborted");
      const { snapshot, hosts } = await collect(capture.config, signal);
      return await this.serialize(() => {
        if (request !== this.request || capture.revision !== this.state.configRevision || this.pendingThresholds) return false;
        if (signal?.aborted) throw new Error("refresh aborted");
        const tooOld = this.clock.mono() - startedMono >= ADVICE_LIFETIME_MS;
        this.publish({
          machines: Object.freeze(snapshot.machines.map(m => Object.freeze({ ...m }))),
          threadHost: readonlyMap(snapshot.threadHost),
          projectHosts: readonlyMap(new Map([...snapshot.projectHosts].map(([id, hosts]) => [id, readonlySet(hosts)]))),
          sampledAt: snapshot.sampledAt, sampleStartedAt: startedAt, sampleStartedMono: startedMono,
          sampleRevision: request, sampleConfigRevision: capture.revision,
          config: this.freezeConfig(mergeMachineConfig(capture.config.machines, hosts)),
          pending: false, failure: tooOld ? "observations expired during collection" : null,
        });
        return true;
      });
    } catch (error) {
      await this.serialize(() => {
        if (request === this.request && capture.revision === this.state.configRevision) {
          this.publish({ failure: `refresh failed: ${error instanceof Error ? error.message : String(error)}` });
        }
      });
      throw error;
    }
  }

  /** Bound the whole refresh, including time queued behind configuration writes. */
  async refreshForTool(collect: Collector, signal?: AbortSignal): Promise<string | null> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ownedRequest = 0;
    const timeout = new Promise<string>(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve("refresh timed out after five seconds"); }, REFRESH_DEADLINE_MS);
    });
    const aborted = new Promise<string>(resolve => {
      controller.signal.addEventListener("abort", () => resolve("refresh aborted or timed out after five seconds"), { once: true });
      if (controller.signal.aborted) resolve("refresh aborted");
    });
    try {
      const work = async (): Promise<string | null> => {
        while (!controller.signal.aborted) {
          try {
            ownedRequest = this.request + 1;
            if (await this.refresh(collect, controller.signal)) return null;
          } catch (error) {
            return `refresh failed: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
        return "refresh aborted";
      };
      const failure = await Promise.race([work(), timeout, aborted]);
      if (failure && controller.signal.aborted && ownedRequest === this.request) {
        // Invalidate the timed-out request immediately, even if storage holds the queue.
        // An uncooperative collector cannot restore its result after the deadline.
        this.request++;
        this.publish({ failure });
      }
      return failure;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
}
