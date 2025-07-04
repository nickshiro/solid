// Inspired by S.js by Adam Haile, https://github.com/adamhaile/S
/**
The MIT License (MIT)

Copyright (c) 2017 Adam Haile

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

import { requestCallback, Task } from "./scheduler.js";
import { setHydrateContext, sharedConfig } from "../render/hydration.js";
import type { JSX } from "../jsx.js";
import type { FlowComponent, FlowProps } from "../render/index.js";

// replaced during build
export const IS_DEV = "_SOLID_DEV_" as string | boolean;

export const equalFn = <T>(a: T, b: T) => a === b;
export const $PROXY = Symbol("solid-proxy");
export const SUPPORTS_PROXY = typeof Proxy === "function";
export const $TRACK = Symbol("solid-track");
export const $DEVCOMP = Symbol("solid-dev-component");
const signalOptions = { equals: equalFn };
let ERROR: symbol | null = null;
let runEffects = runQueue;
const STALE = 1;
const PENDING = 2;
const UNOWNED: Owner = {
  owned: null,
  cleanups: null,
  context: null,
  owner: null
};
const NO_INIT = {};
export var Owner: Owner | null = null;
export let Transition: TransitionState | null = null;
let Scheduler: ((fn: () => void) => any) | null = null;
let ExternalSourceConfig: {
  factory: ExternalSourceFactory;
  untrack: <V>(fn: () => V) => V;
} | null = null;
let Listener: Computation<any> | null = null;
let Updates: Computation<any>[] | null = null;
let Effects: Computation<any>[] | null = null;
let ExecCount = 0;

/** Object storing callbacks for debugging during development */
export const DevHooks: {
  afterUpdate: (() => void) | null;
  afterCreateOwner: ((owner: Owner) => void) | null;
  /** @deprecated use `afterRegisterGraph` */
  afterCreateSignal: ((signal: SignalState<any>) => void) | null;
  afterRegisterGraph: ((sourceMapValue: SourceMapValue) => void) | null;
} = {
  afterUpdate: null,
  afterCreateOwner: null,
  afterCreateSignal: null,
  afterRegisterGraph: null
};

export type ComputationState = 0 | 1 | 2;

export interface SourceMapValue {
  value: unknown;
  name?: string;
  graph?: Owner;
}

export interface SignalState<T> extends SourceMapValue {
  value: T;
  observers: Computation<any>[] | null;
  observerSlots: number[] | null;
  tValue?: T;
  comparator?: (prev: T, next: T) => boolean;
  // development-only
  internal?: true;
}

export interface Owner {
  owned: Computation<any>[] | null;
  cleanups: (() => void)[] | null;
  owner: Owner | null;
  context: any | null;
  sourceMap?: SourceMapValue[];
  name?: string;
}

export interface Computation<Init, Next extends Init = Init> extends Owner {
  fn: EffectFunction<Init, Next>;
  state: ComputationState;
  tState?: ComputationState;
  sources: SignalState<Next>[] | null;
  sourceSlots: number[] | null;
  value?: Init;
  updatedAt: number | null;
  pure: boolean;
  user?: boolean;
  suspense?: SuspenseContextType;
}

export interface TransitionState {
  sources: Set<SignalState<any>>;
  effects: Computation<any>[];
  promises: Set<Promise<any>>;
  disposed: Set<Computation<any>>;
  queue: Set<Computation<any>>;
  scheduler?: (fn: () => void) => unknown;
  running: boolean;
  done?: Promise<void>;
  resolve?: () => void;
}

type ExternalSourceFactory = <Prev, Next extends Prev = Prev>(
  fn: EffectFunction<Prev, Next>,
  trigger: () => void
) => ExternalSource;

export interface ExternalSource {
  track: EffectFunction<any, any>;
  dispose: () => void;
}

export type RootFunction<T> = (dispose: () => void) => T;

/**
 * Creates a new non-tracked reactive context that doesn't auto-dispose
 *
 * @param fn a function in which the reactive state is scoped
 * @param detachedOwner optional reactive context to bind the root to
 * @returns the output of `fn`.
 *
 * @description https://docs.solidjs.com/reference/reactive-utilities/create-root
 */
export function createRoot<T>(fn: RootFunction<T>, detachedOwner?: typeof Owner): T {
  const listener = Listener,
    owner = Owner,
    unowned = fn.length === 0,
    current = detachedOwner === undefined ? owner : detachedOwner,
    root: Owner = unowned
      ? IS_DEV
        ? { owned: null, cleanups: null, context: null, owner: null }
        : UNOWNED
      : {
          owned: null,
          cleanups: null,
          context: current ? current.context : null,
          owner: current
        },
    updateFn = unowned
      ? IS_DEV
        ? () =>
            fn(() => {
              throw new Error("Dispose method must be an explicit argument to createRoot function");
            })
        : fn
      : () => fn(() => untrack(() => cleanNode(root)));

  if (IS_DEV) DevHooks.afterCreateOwner && DevHooks.afterCreateOwner(root);

  Owner = root;
  Listener = null;

  try {
    return runUpdates(updateFn as () => T, true)!;
  } finally {
    Listener = listener;
    Owner = owner;
  }
}

export type Accessor<T> = () => T;

export type Setter<in out T> = {
  <U extends T>(
    ...args: undefined extends T ? [] : [value: Exclude<U, Function> | ((prev: T) => U)]
  ): undefined extends T ? undefined : U;
  <U extends T>(value: (prev: T) => U): U;
  <U extends T>(value: Exclude<U, Function>): U;
  <U extends T>(value: Exclude<U, Function> | ((prev: T) => U)): U;
};

export type Signal<T> = [get: Accessor<T>, set: Setter<T>];

export interface SignalOptions<T> extends MemoOptions<T> {
  internal?: boolean;
}

/**
 * Creates a simple reactive state with a getter and setter
 * ```typescript
 * const [state: Accessor<T>, setState: Setter<T>] = createSignal<T>(
 *  value: T,
 *  options?: { name?: string, equals?: false | ((prev: T, next: T) => boolean) }
 * )
 * ```
 * @param value initial value of the state; if empty, the state's type will automatically extended with undefined; otherwise you need to extend the type manually if you want setting to undefined not be an error
 * @param options optional object with a name for debugging purposes and equals, a comparator function for the previous and next value to allow fine-grained control over the reactivity
 *
 * @returns ```typescript
 * [state: Accessor<T>, setState: Setter<T>]
 * ```
 * * the Accessor is merely a function that returns the current value and registers each call to the reactive root
 * * the Setter is a function that allows directly setting or mutating the value:
 * ```typescript
 * const [count, setCount] = createSignal(0);
 * setCount(count => count + 1);
 * ```
 *
 * @description https://docs.solidjs.com/reference/basic-reactivity/create-signal
 */
export function createSignal<T>(): Signal<T | undefined>;
export function createSignal<T>(value: T, options?: SignalOptions<T>): Signal<T>;
export function createSignal<T>(
  value?: T,
  options?: SignalOptions<T | undefined>
): Signal<T | undefined> {
  options = options ? Object.assign({}, signalOptions, options) : signalOptions;

  const s: SignalState<T | undefined> = {
    value,
    observers: null,
    observerSlots: null,
    comparator: options.equals || undefined
  };

  if (IS_DEV) {
    if (options.name) s.name = options.name;
    if (options.internal) {
      s.internal = true;
    } else {
      registerGraph(s);
      if (DevHooks.afterCreateSignal) DevHooks.afterCreateSignal(s);
    }
  }

  const setter: Setter<T | undefined> = (value?: unknown) => {
    if (typeof value === "function") {
      if (Transition && Transition.running && Transition.sources.has(s)) value = value(s.tValue);
      else value = value(s.value);
    }
    return writeSignal(s, value);
  };

  return [readSignal.bind(s), setter];
}

export interface BaseOptions {
  name?: string;
}

// Magic type that when used at sites where generic types are inferred from, will prevent those sites from being involved in the inference.
// https://github.com/microsoft/TypeScript/issues/14829
// TypeScript Discord conversation: https://discord.com/channels/508357248330760243/508357248330760249/911266491024949328
export type NoInfer<T extends any> = [T][T extends any ? 0 : never];

export interface EffectOptions extends BaseOptions {}

// Also similar to OnEffectFunction
export type EffectFunction<Prev, Next extends Prev = Prev> = (v: Prev) => Next;

/**
 * Creates a reactive computation that runs immediately before render, mainly used to write to other reactive primitives
 * ```typescript
 * export function createComputed<Next, Init = Next>(
 *   fn: (v: Init | Next) => Next,
 *   value?: Init,
 *   options?: { name?: string }
 * ): void;
 * ```
 * @param fn a function that receives its previous or the initial value, if set, and returns a new value used to react on a computation
 * @param value an optional initial value for the computation; if set, fn will never receive undefined as first argument
 * @param options allows to set a name in dev mode for debugging purposes
 *
 * @description https://docs.solidjs.com/reference/secondary-primitives/create-computed
 */
export function createComputed<Next>(fn: EffectFunction<undefined | NoInfer<Next>, Next>): void;
export function createComputed<Next, Init = Next>(
  fn: EffectFunction<Init | Next, Next>,
  value: Init,
  options?: EffectOptions
): void;
export function createComputed<Next, Init>(
  fn: EffectFunction<Init | Next, Next>,
  value?: Init,
  options?: EffectOptions
): void {
  const c = createComputation(fn, value!, true, STALE, IS_DEV ? options : undefined);
  if (Scheduler && Transition && Transition.running) Updates!.push(c);
  else updateComputation(c);
}

/**
 * Creates a reactive computation that runs during the render phase as DOM elements are created and updated but not necessarily connected
 * ```typescript
 * export function createRenderEffect<T>(
 *   fn: (v: T) => T,
 *   value?: T,
 *   options?: { name?: string }
 * ): void;
 * ```
 * @param fn a function that receives its previous or the initial value, if set, and returns a new value used to react on a computation
 * @param value an optional initial value for the computation; if set, fn will never receive undefined as first argument
 * @param options allows to set a name in dev mode for debugging purposes
 *
 * @description https://docs.solidjs.com/reference/secondary-primitives/create-render-effect
 */
export function createRenderEffect<Next>(fn: EffectFunction<undefined | NoInfer<Next>, Next>): void;
export function createRenderEffect<Next, Init = Next>(
  fn: EffectFunction<Init | Next, Next>,
  value: Init,
  options?: EffectOptions
): void;
export function createRenderEffect<Next, Init>(
  fn: EffectFunction<Init | Next, Next>,
  value?: Init,
  options?: EffectOptions
): void {
  const c = createComputation(fn, value!, false, STALE, IS_DEV ? options : undefined);
  if (Scheduler && Transition && Transition.running) Updates!.push(c);
  else updateComputation(c);
}

/**
 * Creates a reactive computation that runs after the render phase
 * ```typescript
 * export function createEffect<T>(
 *   fn: (v: T) => T,
 *   value?: T,
 *   options?: { name?: string }
 * ): void;
 * ```
 * @param fn a function that receives its previous or the initial value, if set, and returns a new value used to react on a computation
 * @param value an optional initial value for the computation; if set, fn will never receive undefined as first argument
 * @param options allows to set a name in dev mode for debugging purposes
 *
 * @description https://docs.solidjs.com/reference/basic-reactivity/create-effect
 */
export function createEffect<Next>(fn: EffectFunction<undefined | NoInfer<Next>, Next>): void;
export function createEffect<Next, Init = Next>(
  fn: EffectFunction<Init | Next, Next>,
  value: Init,
  options?: EffectOptions & { render?: boolean }
): void;
export function createEffect<Next, Init>(
  fn: EffectFunction<Init | Next, Next>,
  value?: Init,
  options?: EffectOptions & { render?: boolean }
): void {
  runEffects = runUserEffects;
  const c = createComputation(fn, value!, false, STALE, IS_DEV ? options : undefined),
    s = SuspenseContext && useContext(SuspenseContext);
  if (s) c.suspense = s;
  if (!options || !options.render) c.user = true;
  Effects ? Effects.push(c) : updateComputation(c);
}

/**
 * Creates a reactive computation that runs after the render phase with flexible tracking
 * ```typescript
 * export function createReaction(
 *   onInvalidate: () => void,
 *   options?: { name?: string }
 * ): (fn: () => void) => void;
 * ```
 * @param invalidated a function that is called when tracked function is invalidated.
 * @param options allows to set a name in dev mode for debugging purposes
 *
 * @description https://docs.solidjs.com/reference/secondary-primitives/create-reaction
 */
export function createReaction(onInvalidate: () => void, options?: EffectOptions) {
  let fn: (() => void) | undefined;
  const c = createComputation(
      () => {
        fn ? fn() : untrack(onInvalidate);
        fn = undefined;
      },
      undefined,
      false,
      0,
      IS_DEV ? options : undefined
    ),
    s = SuspenseContext && useContext(SuspenseContext);
  if (s) c.suspense = s;
  c.user = true;
  return (tracking: () => void) => {
    fn = tracking;
    updateComputation(c);
  };
}

export interface Memo<Prev, Next = Prev> extends SignalState<Next>, Computation<Next> {
  value: Next;
  tOwned?: Computation<Prev | Next, Next>[];
}

export interface MemoOptions<T> extends EffectOptions {
  equals?: false | ((prev: T, next: T) => boolean);
}

/**
 * Creates a readonly derived reactive memoized signal
 * ```typescript
 * export function createMemo<T>(
 *   fn: (v: T) => T,
 *   value?: T,
 *   options?: { name?: string, equals?: false | ((prev: T, next: T) => boolean) }
 * ): () => T;
 * ```
 * @param fn a function that receives its previous or the initial value, if set, and returns a new value used to react on a computation
 * @param value an optional initial value for the computation; if set, fn will never receive undefined as first argument
 * @param options allows to set a name in dev mode for debugging purposes and use a custom comparison function in equals
 *
 * @description https://docs.solidjs.com/reference/basic-reactivity/create-memo
 */
// The extra Prev generic parameter separates inference of the effect input
// parameter type from inference of the effect return type, so that the effect
// return type is always used as the memo Accessor's return type.
export function createMemo<Next extends Prev, Prev = Next>(
  fn: EffectFunction<undefined | NoInfer<Prev>, Next>
): Accessor<Next>;
export function createMemo<Next extends Prev, Init = Next, Prev = Next>(
  fn: EffectFunction<Init | Prev, Next>,
  value: Init,
  options?: MemoOptions<Next>
): Accessor<Next>;
export function createMemo<Next extends Prev, Init, Prev>(
  fn: EffectFunction<Init | Prev, Next>,
  value?: Init,
  options?: MemoOptions<Next>
): Accessor<Next> {
  options = options ? Object.assign({}, signalOptions, options) : signalOptions;

  const c: Partial<Memo<Init, Next>> = createComputation(
    fn,
    value!,
    true,
    0,
    IS_DEV ? options : undefined
  ) as Partial<Memo<Init, Next>>;

  c.observers = null;
  c.observerSlots = null;
  c.comparator = options.equals || undefined;
  if (Scheduler && Transition && Transition.running) {
    c.tState = STALE;
    Updates!.push(c as Memo<Init, Next>);
  } else updateComputation(c as Memo<Init, Next>);
  return readSignal.bind(c as Memo<Init, Next>);
}

interface Unresolved {
  state: "unresolved";
  loading: false;
  error: undefined;
  latest: undefined;
  (): undefined;
}

interface Pending {
  state: "pending";
  loading: true;
  error: undefined;
  latest: undefined;
  (): undefined;
}

interface Ready<T> {
  state: "ready";
  loading: false;
  error: undefined;
  latest: T;
  (): T;
}

interface Refreshing<T> {
  state: "refreshing";
  loading: true;
  error: undefined;
  latest: T;
  (): T;
}

interface Errored {
  state: "errored";
  loading: false;
  error: any;
  latest: never;
  (): never;
}

export type Resource<T> = Unresolved | Pending | Ready<T> | Refreshing<T> | Errored;

export type InitializedResource<T> = Ready<T> | Refreshing<T> | Errored;

export type ResourceActions<T, R = unknown> = {
  mutate: Setter<T>;
  refetch: (info?: R) => T | Promise<T> | undefined | null;
};

export type ResourceSource<S> = S | false | null | undefined | (() => S | false | null | undefined);

export type ResourceFetcher<S, T, R = unknown> = (
  k: S,
  info: ResourceFetcherInfo<T, R>
) => T | Promise<T>;

export type ResourceFetcherInfo<T, R = unknown> = {
  value: T | undefined;
  refetching: R | boolean;
};

export type ResourceOptions<T, S = unknown> = {
  initialValue?: T;
  name?: string;
  deferStream?: boolean;
  ssrLoadFrom?: "initial" | "server";
  storage?: (init: T | undefined) => [Accessor<T | undefined>, Setter<T | undefined>];
  onHydrated?: (k: S | undefined, info: { value: T | undefined }) => void;
};

export type InitializedResourceOptions<T, S = unknown> = ResourceOptions<T, S> & {
  initialValue: T;
};

export type ResourceReturn<T, R = unknown> = [Resource<T>, ResourceActions<T | undefined, R>];

export type InitializedResourceReturn<T, R = unknown> = [
  InitializedResource<T>,
  ResourceActions<T, R>
];

function isPromise(v: any): v is Promise<any> {
  return v && typeof v === "object" && "then" in v;
}

/**
 * Creates a resource that wraps a repeated promise in a reactive pattern:
 * ```typescript
 * // Without source
 * const [resource, { mutate, refetch }] = createResource(fetcher, options);
 * // With source
 * const [resource, { mutate, refetch }] = createResource(source, fetcher, options);
 * ```
 * @param source - reactive data function which has its non-nullish and non-false values passed to the fetcher, optional
 * @param fetcher - function that receives the source (true if source not provided), the last or initial value, and whether the resource is being refetched, and returns a value or a Promise:
 * ```typescript
 * const fetcher: ResourceFetcher<S, T, R> = (
 *   sourceOutput: S,
 *   info: { value: T | undefined, refetching: R | boolean }
 * ) => T | Promise<T>;
 * ```
 * @param options - an optional object with the initialValue and the name (for debugging purposes); see {@link ResourceOptions}
 *
 * @returns ```typescript
 * [Resource<T>, { mutate: Setter<T>, refetch: () => void }]
 * ```
 *
 * * Setting an `initialValue` in the options will mean that both the prev() accessor and the resource should never return undefined (if that is wanted, you need to extend the type with undefined)
 * * `mutate` allows to manually overwrite the resource without calling the fetcher
 * * `refetch` will re-run the fetcher without changing the source, and if called with a value, that value will be passed to the fetcher via the `refetching` property on the fetcher's second parameter
 *
 * @description https://docs.solidjs.com/reference/basic-reactivity/create-resource
 */
export function createResource<T, R = unknown>(
  fetcher: ResourceFetcher<true, T, R>,
  options: InitializedResourceOptions<NoInfer<T>, true>
): InitializedResourceReturn<T, R>;
export function createResource<T, R = unknown>(
  fetcher: ResourceFetcher<true, T, R>,
  options?: ResourceOptions<NoInfer<T>, true>
): ResourceReturn<T, R>;
export function createResource<T, S, R = unknown>(
  source: ResourceSource<S>,
  fetcher: ResourceFetcher<S, T, R>,
  options: InitializedResourceOptions<NoInfer<T>, S>
): InitializedResourceReturn<T, R>;
export function createResource<T, S, R = unknown>(
  source: ResourceSource<S>,
  fetcher: ResourceFetcher<S, T, R>,
  options?: ResourceOptions<NoInfer<T>, S>
): ResourceReturn<T, R>;
export function createResource<T, S, R>(
  pSource: ResourceSource<S> | ResourceFetcher<S, T, R>,
  pFetcher?: ResourceFetcher<S, T, R> | ResourceOptions<T, S>,
  pOptions?: ResourceOptions<T, S> | undefined
): ResourceReturn<T, R> {
  let source: ResourceSource<S>;
  let fetcher: ResourceFetcher<S, T, R>;
  let options: ResourceOptions<T, S>;

  if (typeof pFetcher === "function") {
    source = pSource as ResourceSource<S>;
    fetcher = pFetcher as ResourceFetcher<S, T, R>;
    options = pOptions || ({} as ResourceOptions<T, S>);
  } else {
    source = true as ResourceSource<S>;
    fetcher = pSource as ResourceFetcher<S, T, R>;
    options = (pFetcher || {}) as ResourceOptions<T, S>;
  }

  let pr: Promise<T> | null = null,
    initP: Promise<T> | T | typeof NO_INIT = NO_INIT,
    id: string | null = null,
    loadedUnderTransition: boolean | null = false,
    scheduled = false,
    resolved = "initialValue" in options,
    dynamic =
      typeof source === "function" && createMemo(source as () => S | false | null | undefined);

  const contexts = new Set<SuspenseContextType>(),
    [value, setValue] = (options.storage || createSignal)(options.initialValue) as Signal<
      T | undefined
    >,
    [error, setError] = createSignal<unknown>(undefined),
    [track, trigger] = createSignal(undefined, { equals: false }),
    [state, setState] = createSignal<"unresolved" | "pending" | "ready" | "refreshing" | "errored">(
      resolved ? "ready" : "unresolved"
    );

  if (sharedConfig.context) {
    id = sharedConfig.getNextContextId();
    if (options.ssrLoadFrom === "initial") initP = options.initialValue as T;
    else if (sharedConfig.load && sharedConfig.has!(id)) initP = sharedConfig.load(id);
  }
  function loadEnd(p: Promise<T> | null, v: T | undefined, error?: any, key?: S) {
    if (pr === p) {
      pr = null;
      key !== undefined && (resolved = true);
      if ((p === initP || v === initP) && options.onHydrated)
        queueMicrotask(() => options.onHydrated!(key, { value: v }));
      initP = NO_INIT;
      if (Transition && p && loadedUnderTransition) {
        Transition.promises.delete(p);
        loadedUnderTransition = false;
        runUpdates(() => {
          Transition!.running = true;
          completeLoad(v, error);
        }, false);
      } else completeLoad(v, error);
    }
    return v;
  }
  function completeLoad(v: T | undefined, err: any) {
    runUpdates(() => {
      if (err === undefined) setValue(() => v);
      setState(err !== undefined ? "errored" : resolved ? "ready" : "unresolved");
      setError(err);
      for (const c of contexts.keys()) c.decrement!();
      contexts.clear();
    }, false);
  }

  function read() {
    const c = SuspenseContext && useContext(SuspenseContext),
      v = value(),
      err = error();
    if (err !== undefined && !pr) throw err;
    if (Listener && !Listener.user && c) {
      createComputed(() => {
        track();
        if (pr) {
          if (c.resolved && Transition && loadedUnderTransition) Transition.promises.add(pr);
          else if (!contexts.has(c)) {
            c.increment!();
            contexts.add(c);
          }
        }
      });
    }
    return v;
  }
  function load(refetching: R | boolean = true) {
    if (refetching !== false && scheduled) return;
    scheduled = false;
    const lookup = dynamic ? dynamic() : (source as S);
    loadedUnderTransition = Transition && Transition.running;
    if (lookup == null || lookup === false) {
      loadEnd(pr, untrack(value));
      return;
    }
    if (Transition && pr) Transition.promises.delete(pr);
    let error: unknown;
    const p =
      initP !== NO_INIT
        ? (initP as T | Promise<T>)
        : untrack(() => {
            try {
              return fetcher(lookup, {
                value: value(),
                refetching
              });
            } catch (fetcherError) {
              error = fetcherError;
            }
          });
    if (error !== undefined) {
      loadEnd(pr, undefined, castError(error), lookup);
      return;
    } else if (!isPromise(p)) {
      loadEnd(pr, p, undefined, lookup);
      return p;
    }
    pr = p;
    if ("v" in p) {
      if ((p as any).s === 1) loadEnd(pr, p.v as T, undefined, lookup);
      else loadEnd(pr, undefined, castError(p.v), lookup);
      return p;
    }
    scheduled = true;
    queueMicrotask(() => (scheduled = false));
    runUpdates(() => {
      setState(resolved ? "refreshing" : "pending");
      trigger();
    }, false);
    return p.then(
      v => loadEnd(p, v, undefined, lookup),
      e => loadEnd(p, undefined, castError(e), lookup)
    ) as Promise<T>;
  }
  Object.defineProperties(read, {
    state: { get: () => state() },
    error: { get: () => error() },
    loading: {
      get() {
        const s = state();
        return s === "pending" || s === "refreshing";
      }
    },
    latest: {
      get() {
        if (!resolved) return read();
        const err = error();
        if (err && !pr) throw err;
        return value();
      }
    }
  });
  let owner = Owner;
  if (dynamic) createComputed(() => ((owner = Owner), load(false)));
  else load(false);
  return [
    read as Resource<T>,
    { refetch: info => runWithOwner(owner, () => load(info)), mutate: setValue }
  ];
}

export interface DeferredOptions<T> {
  equals?: false | ((prev: T, next: T) => boolean);
  name?: string;
  timeoutMs?: number;
}

/**
 * Creates a reactive computation that only runs and notifies the reactive context when the browser is idle
 * ```typescript
 * export function createDeferred<T>(
 *   fn: (v: T) => T,
 *   options?: { timeoutMs?: number, name?: string, equals?: false | ((prev: T, next: T) => boolean) }
 * ): () => T);
 * ```
 * @param fn a function that receives its previous or the initial value, if set, and returns a new value used to react on a computation
 * @param options allows to set the timeout in milliseconds, use a custom comparison function and set a name in dev mode for debugging purposes
 *
 * @description https://docs.solidjs.com/reference/secondary-primitives/create-deferred
 */
export function createDeferred<T>(source: Accessor<T>, options?: DeferredOptions<T>) {
  let t: Task,
    timeout = options ? options.timeoutMs : undefined;
  const node = createComputation(
    () => {
      if (!t || !t.fn)
        t = requestCallback(
          () => setDeferred(() => node.value as T),
          timeout !== undefined ? { timeout } : undefined
        );
      return source();
    },
    undefined,
    true
  ) as Memo<any>;
  const [deferred, setDeferred] = createSignal(
    Transition && Transition.running && Transition.sources.has(node) ? node.tValue : node.value,
    options
  );
  updateComputation(node);
  setDeferred(() =>
    Transition && Transition.running && Transition.sources.has(node) ? node.tValue : node.value
  );
  return deferred;
}

export type EqualityCheckerFunction<T, U> = (a: U, b: T) => boolean;

/**
 * Creates a conditional signal that only notifies subscribers when entering or exiting their key matching the value
 * ```typescript
 * export function createSelector<T, U>(
 *   source: () => T
 *   fn: (a: U, b: T) => boolean,
 *   options?: { name?: string }
 * ): (k: U) => boolean;
 * ```
 * @param source
 * @param fn a function that receives its previous or the initial value, if set, and returns a new value used to react on a computation
 * @param options allows to set a name in dev mode for debugging purposes, optional
 *
 * ```typescript
 * const isSelected = createSelector(selectedId);
 * <For each={list()}>
 *   {(item) => <li classList={{ active: isSelected(item.id) }}>{item.name}</li>}
 * </For>
 * ```
 *
 * This makes the operation O(2) instead of O(n).
 *
 * @description https://docs.solidjs.com/reference/secondary-primitives/create-selector
 */
export function createSelector<T, U = T>(
  source: Accessor<T>,
  fn: EqualityCheckerFunction<T, U> = equalFn as TODO,
  options?: BaseOptions
): (key: U) => boolean {
  const subs = new Map<U, Set<Computation<any>>>();
  const node = createComputation(
    (p: T | undefined) => {
      const v = source();
      for (const [key, val] of subs.entries())
        if (fn(key, v) !== fn(key, p!)) {
          for (const c of val.values()) {
            c.state = STALE;
            if (c.pure) Updates!.push(c);
            else Effects!.push(c);
          }
        }
      return v;
    },
    undefined,
    true,
    STALE,
    IS_DEV ? options : undefined
  ) as Memo<any>;
  updateComputation(node);
  return (key: U) => {
    const listener = Listener;
    if (listener) {
      let l: Set<Computation<any>> | undefined;
      if ((l = subs.get(key))) l.add(listener);
      else subs.set(key, (l = new Set([listener])));
      onCleanup(() => {
        l.delete(listener);
        !l.size && subs.delete(key);
      });
    }
    return fn(
      key,
      Transition && Transition.running && Transition.sources.has(node) ? node.tValue : node.value!
    );
  };
}

/**
 * Holds changes inside the block before the reactive context is updated
 * @param fn wraps the reactive updates that should be batched
 * @returns the return value from `fn`
 *
 * @description https://docs.solidjs.com/reference/reactive-utilities/batch
 */
export function batch<T>(fn: Accessor<T>): T {
  return runUpdates(fn, false) as T;
}

/**
 * Ignores tracking context inside its scope
 * @param fn the scope that is out of the tracking context
 * @returns the return value of `fn`
 *
 * @description https://docs.solidjs.com/reference/reactive-utilities/untrack
 */
export function untrack<T>(fn: Accessor<T>): T {
  if (!ExternalSourceConfig && Listener === null) return fn();

  const listener = Listener;
  Listener = null;
  try {
    if (ExternalSourceConfig) return ExternalSourceConfig.untrack(fn);
    return fn();
  } finally {
    Listener = listener;
  }
}

/** @deprecated */
export type ReturnTypes<T> = T extends readonly Accessor<unknown>[]
  ? { [K in keyof T]: T[K] extends Accessor<infer I> ? I : never }
  : T extends Accessor<infer I>
    ? I
    : never;

// transforms a tuple to a tuple of accessors in a way that allows generics to be inferred
export type AccessorArray<T> = [...Extract<{ [K in keyof T]: Accessor<T[K]> }, readonly unknown[]>];

// Also similar to EffectFunction
export type OnEffectFunction<S, Prev, Next extends Prev = Prev> = (
  input: S,
  prevInput: S | undefined,
  prev: Prev
) => Next;

export interface OnOptions {
  defer?: boolean;
}

/**
 * Makes dependencies of a computation explicit
 * ```typescript
 * export function on<S, U>(
 *   deps: Accessor<S> | AccessorArray<S>,
 *   fn: (input: S, prevInput: S | undefined, prevValue: U | undefined) => U,
 *   options?: { defer?: boolean } = {}
 * ): (prevValue: U | undefined) => U;
 * ```
 * @param deps list of reactive dependencies or a single reactive dependency
 * @param fn computation on input; the current previous content(s) of input and the previous value are given as arguments and it returns a new value
 * @param options optional, allows deferred computation until at the end of the next change
 * @returns an effect function that is passed into createEffect. For example:
 *
 * ```typescript
 * createEffect(on(a, (v) => console.log(v, b())));
 *
 * // is equivalent to:
 * createEffect(() => {
 *   const v = a();
 *   untrack(() => console.log(v, b()));
 * });
 * ```
 *
 * @description https://docs.solidjs.com/reference/reactive-utilities/on
 */
export function on<S, Next extends Prev, Prev = Next>(
  deps: AccessorArray<S> | Accessor<S>,
  fn: OnEffectFunction<S, undefined | NoInfer<Prev>, Next>,
  options?: OnOptions & { defer?: false }
): EffectFunction<undefined | NoInfer<Next>, NoInfer<Next>>;
export function on<S, Next extends Prev, Prev = Next>(
  deps: AccessorArray<S> | Accessor<S>,
  fn: OnEffectFunction<S, undefined | NoInfer<Prev>, Next>,
  options: OnOptions | { defer: true }
): EffectFunction<undefined | NoInfer<Next>>;
export function on<S, Next extends Prev, Prev = Next>(
  deps: AccessorArray<S> | Accessor<S>,
  fn: OnEffectFunction<S, undefined | NoInfer<Prev>, Next>,
  options?: OnOptions
): EffectFunction<undefined | NoInfer<Next>> {
  const isArray = Array.isArray(deps);
  let prevInput: S;
  let defer = options && options.defer;
  return prevValue => {
    let input: S;
    if (isArray) {
      input = Array(deps.length) as unknown as S;
      for (let i = 0; i < deps.length; i++) (input as unknown as TODO[])[i] = deps[i]();
    } else input = deps();
    if (defer) {
      defer = false;
      return prevValue;
    }
    const result = untrack(() => fn(input, prevInput, prevValue));
    prevInput = input;
    return result;
  };
}

/**
 * Runs an effect only after initial render on mount
 * @param fn an effect that should run only once on mount
 *
 * @description https://docs.solidjs.com/reference/lifecycle/on-mount
 */
export function onMount(fn: () => void) {
  createEffect(() => untrack(fn));
}

/**
 * Runs an effect once before the reactive scope is disposed
 * @param fn an effect that should run only once on cleanup
 *
 * @returns the same {@link fn} function that was passed in
 *
 * @description https://docs.solidjs.com/reference/lifecycle/on-cleanup
 */
export function onCleanup<T extends () => any>(fn: T): T {
  if (Owner === null)
    IS_DEV && console.warn("cleanups created outside a `createRoot` or `render` will never be run");
  else if (Owner.cleanups === null) Owner.cleanups = [fn];
  else Owner.cleanups.push(fn);
  return fn;
}

/**
 * Runs an effect whenever an error is thrown within the context of the child scopes
 * @param fn boundary for the error
 * @param handler an error handler that receives the error
 *
 * * If the error is thrown again inside the error handler, it will trigger the next available parent handler
 *
 * @description https://docs.solidjs.com/reference/reactive-utilities/catch-error
 */
export function catchError<T>(fn: () => T, handler: (err: Error) => void) {
  ERROR || (ERROR = Symbol("error"));
  Owner = createComputation(undefined!, undefined, true);
  Owner.context = { ...Owner.context, [ERROR]: [handler] };
  if (Transition && Transition.running) Transition.sources.add(Owner as Memo<any>);
  try {
    return fn();
  } catch (err) {
    handleError(err);
  } finally {
    Owner = Owner.owner;
  }
}

export function getListener() {
  return Listener;
}

export function getOwner() {
  return Owner;
}

export function runWithOwner<T>(o: typeof Owner, fn: () => T): T | undefined {
  const prev = Owner;
  const prevListener = Listener;
  Owner = o;
  Listener = null;
  try {
    return runUpdates(fn, true)!;
  } catch (err) {
    handleError(err);
  } finally {
    Owner = prev;
    Listener = prevListener;
  }
}

// Transitions
export function enableScheduling(scheduler = requestCallback) {
  Scheduler = scheduler;
}

/**
 * ```typescript
 * export function startTransition(fn: () => void) => Promise<void>
 * ```
 *
 * @description https://docs.solidjs.com/reference/reactive-utilities/start-transition
 */
export function startTransition(fn: () => unknown): Promise<void> {
  if (Transition && Transition.running) {
    fn();
    return Transition.done!;
  }
  const l = Listener;
  const o = Owner;
  return Promise.resolve().then(() => {
    Listener = l;
    Owner = o;
    let t: TransitionState | undefined;
    if (Scheduler || SuspenseContext) {
      t =
        Transition ||
        (Transition = {
          sources: new Set(),
          effects: [],
          promises: new Set(),
          disposed: new Set(),
          queue: new Set(),
          running: true
        });
      t.done || (t.done = new Promise(res => (t!.resolve = res)));
      t.running = true;
    }
    runUpdates(fn, false);
    Listener = Owner = null;
    return t ? t.done : undefined;
  });
}

// keep immediately evaluated module code, below its dependencies like Listener & createSignal
const [transPending, setTransPending] = /*@__PURE__*/ createSignal(false);

export type Transition = [Accessor<boolean>, (fn: () => void) => Promise<void>];

/**
 * ```typescript
 * export function useTransition(): [
 *   () => boolean,
 *   (fn: () => void, cb?: () => void) => void
 * ];
 * ```
 * @returns a tuple; first value is an accessor if the transition is pending and a callback to start the transition
 *
 * @description https://docs.solidjs.com/reference/reactive-utilities/use-transition
 */
export function useTransition(): Transition {
  return [transPending, startTransition];
}

export function resumeEffects(e: Computation<any>[]) {
  Effects!.push.apply(Effects, e);
  e.length = 0;
}

export interface DevComponent<T> extends Memo<unknown> {
  props: T;
  name: string;
  component: (props: T) => unknown;
}

// Dev
export function devComponent<P, V>(Comp: (props: P) => V, props: P): V {
  const c = createComputation(
    () =>
      untrack(() => {
        Object.assign(Comp, { [$DEVCOMP]: true });
        return Comp(props);
      }),
    undefined,
    true,
    0
  ) as DevComponent<P>;
  c.props = props;
  c.observers = null;
  c.observerSlots = null;
  c.name = Comp.name;
  c.component = Comp;
  updateComputation(c);
  return (c.tValue !== undefined ? c.tValue : c.value) as V;
}

export function registerGraph(value: SourceMapValue): void {
  if (Owner) {
    if (Owner.sourceMap) Owner.sourceMap.push(value);
    else Owner.sourceMap = [value];
    value.graph = Owner;
  }
  if (DevHooks.afterRegisterGraph) DevHooks.afterRegisterGraph(value);
}

export type ContextProviderComponent<T> = FlowComponent<{ value: T }>;

// Context API
export interface Context<T> {
  id: symbol;
  Provider: ContextProviderComponent<T>;
  defaultValue: T;
}

/**
 * Creates a Context to handle a state scoped for the children of a component
 * ```typescript
 * interface Context<T> {
 *   id: symbol;
 *   Provider: FlowComponent<{ value: T }>;
 *   defaultValue: T;
 * }
 * export function createContext<T>(
 *   defaultValue?: T,
 *   options?: { name?: string }
 * ): Context<T | undefined>;
 * ```
 * @param defaultValue optional default to inject into context
 * @param options allows to set a name in dev mode for debugging purposes
 * @returns The context that contains the Provider Component and that can be used with `useContext`
 *
 * @description https://docs.solidjs.com/reference/component-apis/create-context
 */
export function createContext<T>(
  defaultValue?: undefined,
  options?: EffectOptions
): Context<T | undefined>;
export function createContext<T>(defaultValue: T, options?: EffectOptions): Context<T>;
export function createContext<T>(
  defaultValue?: T,
  options?: EffectOptions
): Context<T | undefined> {
  const id = Symbol("context");
  return { id, Provider: createProvider(id, options), defaultValue };
}

/**
 * Uses a context to receive a scoped state from a parent's Context.Provider
 *
 * @param context Context object made by `createContext`
 * @returns the current or `defaultValue`, if present
 *
 * @description https://docs.solidjs.com/reference/component-apis/use-context
 */
export function useContext<T>(context: Context<T>): T {
  let value: undefined | T;
  return Owner && Owner.context && (value = Owner.context[context.id]) !== undefined
    ? value
    : context.defaultValue;
}

export type ResolvedJSXElement = Exclude<JSX.Element, JSX.ArrayElement>;
export type ResolvedChildren = ResolvedJSXElement | ResolvedJSXElement[];
export type ChildrenReturn = Accessor<ResolvedChildren> & { toArray: () => ResolvedJSXElement[] };

/**
 * Resolves child elements to help interact with children
 *
 * @param fn an accessor for the children
 * @returns a accessor of the same children, but resolved
 *
 * @description https://docs.solidjs.com/reference/component-apis/children
 */
export function children(fn: Accessor<JSX.Element>): ChildrenReturn {
  const children = createMemo(fn);
  const memo = IS_DEV
    ? createMemo(() => resolveChildren(children()), undefined, { name: "children" })
    : createMemo(() => resolveChildren(children()));
  (memo as ChildrenReturn).toArray = () => {
    const c = memo();
    return Array.isArray(c) ? c : c != null ? [c] : [];
  };
  return memo as ChildrenReturn;
}

// Resource API
export type SuspenseContextType = {
  increment?: () => void;
  decrement?: () => void;
  inFallback?: () => boolean;
  effects?: Computation<any>[];
  resolved?: boolean;
};

type SuspenseContext = Context<SuspenseContextType | undefined> & {
  active?(): boolean;
  increment?(): void;
  decrement?(): void;
};

let SuspenseContext: SuspenseContext;

export function getSuspenseContext() {
  return SuspenseContext || (SuspenseContext = createContext<SuspenseContextType | undefined>());
}

// Interop
export function enableExternalSource(
  factory: ExternalSourceFactory,
  untrack: <V>(fn: () => V) => V = fn => fn()
) {
  if (ExternalSourceConfig) {
    const { factory: oldFactory, untrack: oldUntrack } = ExternalSourceConfig;
    ExternalSourceConfig = {
      factory: (fn, trigger) => {
        const oldSource = oldFactory(fn, trigger);
        const source = factory(x => oldSource.track(x), trigger);
        return {
          track: x => source.track(x),
          dispose() {
            source.dispose();
            oldSource.dispose();
          }
        };
      },
      untrack: fn => oldUntrack(() => untrack(fn))
    };
  } else {
    ExternalSourceConfig = { factory, untrack };
  }
}

// Internal
export function readSignal(this: SignalState<any> | Memo<any>) {
  const runningTransition = Transition && Transition.running;
  if (
    (this as Memo<any>).sources &&
    (runningTransition ? (this as Memo<any>).tState : (this as Memo<any>).state)
  ) {
    if ((runningTransition ? (this as Memo<any>).tState : (this as Memo<any>).state) === STALE)
      updateComputation(this as Memo<any>);
    else {
      const updates = Updates;
      Updates = null;
      runUpdates(() => lookUpstream(this as Memo<any>), false);
      Updates = updates;
    }
  }
  if (Listener) {
    const sSlot = this.observers ? this.observers.length : 0;
    if (!Listener.sources) {
      Listener.sources = [this];
      Listener.sourceSlots = [sSlot];
    } else {
      Listener.sources.push(this);
      Listener.sourceSlots!.push(sSlot);
    }
    if (!this.observers) {
      this.observers = [Listener];
      this.observerSlots = [Listener.sources.length - 1];
    } else {
      this.observers.push(Listener);
      this.observerSlots!.push(Listener.sources.length - 1);
    }
  }
  if (runningTransition && Transition!.sources.has(this)) return this.tValue;
  return this.value;
}

export function writeSignal(node: SignalState<any> | Memo<any>, value: any, isComp?: boolean) {
  let current =
    Transition && Transition.running && Transition.sources.has(node) ? node.tValue : node.value;
  if (!node.comparator || !node.comparator(current, value)) {
    if (Transition) {
      const TransitionRunning = Transition.running;
      if (TransitionRunning || (!isComp && Transition.sources.has(node))) {
        Transition.sources.add(node);
        node.tValue = value;
      }
      if (!TransitionRunning) node.value = value;
    } else node.value = value;
    if (node.observers && node.observers.length) {
      runUpdates(() => {
        for (let i = 0; i < node.observers!.length; i += 1) {
          const o = node.observers![i];
          const TransitionRunning = Transition && Transition.running;
          if (TransitionRunning && Transition!.disposed.has(o)) continue;
          if (TransitionRunning ? !o.tState : !o.state) {
            if (o.pure) Updates!.push(o);
            else Effects!.push(o);
            if ((o as Memo<any>).observers) markDownstream(o as Memo<any>);
          }
          if (!TransitionRunning) o.state = STALE;
          else o.tState = STALE;
        }
        if (Updates!.length > 10e5) {
          Updates = [];
          if (IS_DEV) throw new Error("Potential Infinite Loop Detected.");
          throw new Error();
        }
      }, false);
    }
  }
  return value;
}

function updateComputation(node: Computation<any>) {
  if (!node.fn) return;
  cleanNode(node);
  const time = ExecCount;
  runComputation(
    node,
    Transition && Transition.running && Transition.sources.has(node as Memo<any>)
      ? (node as Memo<any>).tValue
      : node.value,
    time
  );

  if (Transition && !Transition.running && Transition.sources.has(node as Memo<any>)) {
    queueMicrotask(() => {
      runUpdates(() => {
        Transition && (Transition.running = true);
        Listener = Owner = node;
        runComputation(node, (node as Memo<any>).tValue, time);
        Listener = Owner = null;
      }, false);
    });
  }
}

function runComputation(node: Computation<any>, value: any, time: number) {
  let nextValue;
  const owner = Owner,
    listener = Listener;
  Listener = Owner = node;
  try {
    nextValue = node.fn(value);
  } catch (err) {
    if (node.pure) {
      if (Transition && Transition.running) {
        node.tState = STALE;
        (node as Memo<any>).tOwned && (node as Memo<any>).tOwned!.forEach(cleanNode);
        (node as Memo<any>).tOwned = undefined;
      } else {
        node.state = STALE;
        node.owned && node.owned.forEach(cleanNode);
        node.owned = null;
      }
    }
    // won't be picked up until next update
    node.updatedAt = time + 1;
    return handleError(err);
  } finally {
    Listener = listener;
    Owner = owner;
  }
  if (!node.updatedAt || node.updatedAt <= time) {
    if (node.updatedAt != null && "observers" in node) {
      writeSignal(node as Memo<any>, nextValue, true);
    } else if (Transition && Transition.running && node.pure) {
      Transition.sources.add(node as Memo<any>);
      (node as Memo<any>).tValue = nextValue;
    } else node.value = nextValue;
    node.updatedAt = time;
  }
}

function createComputation<Next, Init = unknown>(
  fn: EffectFunction<Init | Next, Next>,
  init: Init,
  pure: boolean,
  state: ComputationState = STALE,
  options?: EffectOptions
): Computation<Init | Next, Next> {
  const c: Computation<Init | Next, Next> = {
    fn,
    state: state,
    updatedAt: null,
    owned: null,
    sources: null,
    sourceSlots: null,
    cleanups: null,
    value: init,
    owner: Owner,
    context: Owner ? Owner.context : null,
    pure
  };

  if (Transition && Transition.running) {
    c.state = 0;
    c.tState = state;
  }

  if (Owner === null)
    IS_DEV &&
      console.warn(
        "computations created outside a `createRoot` or `render` will never be disposed"
      );
  else if (Owner !== UNOWNED) {
    if (Transition && Transition.running && (Owner as Memo<Init, Next>).pure) {
      if (!(Owner as Memo<Init, Next>).tOwned) (Owner as Memo<Init, Next>).tOwned = [c];
      else (Owner as Memo<Init, Next>).tOwned!.push(c);
    } else {
      if (!Owner.owned) Owner.owned = [c];
      else Owner.owned.push(c);
    }
  }

  if (IS_DEV && options && options.name) c.name = options.name;

  if (ExternalSourceConfig && c.fn) {
    const [track, trigger] = createSignal<void>(undefined, { equals: false });
    const ordinary = ExternalSourceConfig.factory(c.fn, trigger);
    onCleanup(() => ordinary.dispose());
    const triggerInTransition: () => void = () =>
      startTransition(trigger).then(() => inTransition.dispose());
    const inTransition = ExternalSourceConfig.factory(c.fn, triggerInTransition);
    c.fn = x => {
      track();
      return Transition && Transition.running ? inTransition.track(x) : ordinary.track(x);
    };
  }

  if (IS_DEV) DevHooks.afterCreateOwner && DevHooks.afterCreateOwner(c);

  return c;
}

function runTop(node: Computation<any>) {
  const runningTransition = Transition && Transition.running;
  if ((runningTransition ? node.tState : node.state) === 0) return;
  if ((runningTransition ? node.tState : node.state) === PENDING) return lookUpstream(node);
  if (node.suspense && untrack(node.suspense.inFallback!)) return node.suspense.effects!.push(node);
  const ancestors = [node];
  while (
    (node = node.owner as Computation<any>) &&
    (!node.updatedAt || node.updatedAt < ExecCount)
  ) {
    if (runningTransition && Transition!.disposed.has(node)) return;
    if (runningTransition ? node.tState : node.state) ancestors.push(node);
  }
  for (let i = ancestors.length - 1; i >= 0; i--) {
    node = ancestors[i];
    if (runningTransition) {
      let top = node,
        prev = ancestors[i + 1];
      while ((top = top.owner as Computation<any>) && top !== prev) {
        if (Transition!.disposed.has(top)) return;
      }
    }
    if ((runningTransition ? node.tState : node.state) === STALE) {
      updateComputation(node);
    } else if ((runningTransition ? node.tState : node.state) === PENDING) {
      const updates = Updates;
      Updates = null;
      runUpdates(() => lookUpstream(node, ancestors[0]), false);
      Updates = updates;
    }
  }
}

function runUpdates<T>(fn: () => T, init: boolean) {
  if (Updates) return fn();
  let wait = false;
  if (!init) Updates = [];
  if (Effects) wait = true;
  else Effects = [];
  ExecCount++;
  try {
    const res = fn();
    completeUpdates(wait);
    return res;
  } catch (err) {
    if (!wait) Effects = null;
    Updates = null;
    handleError(err);
  }
}

function completeUpdates(wait: boolean) {
  if (Updates) {
    if (Scheduler && Transition && Transition.running) scheduleQueue(Updates);
    else runQueue(Updates);
    Updates = null;
  }
  if (wait) return;
  let res;
  if (Transition) {
    if (!Transition.promises.size && !Transition.queue.size) {
      // finish transition
      const sources = Transition.sources;
      const disposed = Transition.disposed;
      Effects!.push.apply(Effects, Transition!.effects);
      res = Transition.resolve;
      for (const e of Effects!) {
        "tState" in e && (e.state = e.tState!);
        delete e.tState;
      }
      Transition = null;
      runUpdates(() => {
        for (const d of disposed) cleanNode(d);
        for (const v of sources) {
          v.value = v.tValue;
          if ((v as Memo<any>).owned) {
            for (let i = 0, len = (v as Memo<any>).owned!.length; i < len; i++)
              cleanNode((v as Memo<any>).owned![i]);
          }
          if ((v as Memo<any>).tOwned) (v as Memo<any>).owned = (v as Memo<any>).tOwned!;
          delete v.tValue;
          delete (v as Memo<any>).tOwned;
          (v as Memo<any>).tState = 0;
        }
        setTransPending(false);
      }, false);
    } else if (Transition.running) {
      Transition.running = false;
      Transition.effects.push.apply(Transition.effects, Effects!);
      Effects = null;
      setTransPending(true);
      return;
    }
  }
  const e = Effects!;
  Effects = null;
  if (e.length) runUpdates(() => runEffects(e), false);
  else if (IS_DEV) DevHooks.afterUpdate && DevHooks.afterUpdate();
  if (res) res();
}

function runQueue(queue: Computation<any>[]) {
  for (let i = 0; i < queue.length; i++) runTop(queue[i]);
}

function scheduleQueue(queue: Computation<any>[]) {
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    const tasks = Transition!.queue;
    if (!tasks.has(item)) {
      tasks.add(item);
      Scheduler!(() => {
        tasks.delete(item);
        runUpdates(() => {
          Transition!.running = true;
          runTop(item);
        }, false);
        Transition && (Transition.running = false);
      });
    }
  }
}

function runUserEffects(queue: Computation<any>[]) {
  let i,
    userLength = 0;
  for (i = 0; i < queue.length; i++) {
    const e = queue[i];
    if (!e.user) runTop(e);
    else queue[userLength++] = e;
  }
  if (sharedConfig.context) {
    if (sharedConfig.count) {
      sharedConfig.effects || (sharedConfig.effects = []);
      sharedConfig.effects.push(...queue.slice(0, userLength));
      return;
    }
    setHydrateContext();
  }
  if (sharedConfig.effects && (sharedConfig.done || !sharedConfig.count)) {
    queue = [...sharedConfig.effects, ...queue];
    userLength += sharedConfig.effects.length;
    delete sharedConfig.effects;
  }
  for (i = 0; i < userLength; i++) runTop(queue[i]);
}

function lookUpstream(node: Computation<any>, ignore?: Computation<any>) {
  const runningTransition = Transition && Transition.running;
  if (runningTransition) node.tState = 0;
  else node.state = 0;
  for (let i = 0; i < node.sources!.length; i += 1) {
    const source = node.sources![i] as Memo<any>;
    if (source.sources) {
      const state = runningTransition ? source.tState : source.state;
      if (state === STALE) {
        if (source !== ignore && (!source.updatedAt || source.updatedAt < ExecCount))
          runTop(source);
      } else if (state === PENDING) lookUpstream(source, ignore);
    }
  }
}

function markDownstream(node: Memo<any>) {
  const runningTransition = Transition && Transition.running;
  for (let i = 0; i < node.observers!.length; i += 1) {
    const o = node.observers![i];
    if (runningTransition ? !o.tState : !o.state) {
      if (runningTransition) o.tState = PENDING;
      else o.state = PENDING;
      if (o.pure) Updates!.push(o);
      else Effects!.push(o);
      (o as Memo<any>).observers && markDownstream(o as Memo<any>);
    }
  }
}

function cleanNode(node: Owner) {
  let i;
  if ((node as Computation<any>).sources) {
    while ((node as Computation<any>).sources!.length) {
      const source = (node as Computation<any>).sources!.pop()!,
        index = (node as Computation<any>).sourceSlots!.pop()!,
        obs = source.observers;
      if (obs && obs.length) {
        const n = obs.pop()!,
          s = source.observerSlots!.pop()!;
        if (index < obs.length) {
          n.sourceSlots![s] = index;
          obs[index] = n;
          source.observerSlots![index] = s;
        }
      }
    }
  }

  if ((node as Memo<any>).tOwned) {
    for (i = (node as Memo<any>).tOwned!.length - 1; i >= 0; i--)
      cleanNode((node as Memo<any>).tOwned![i]);
    delete (node as Memo<any>).tOwned;
  }
  if (Transition && Transition.running && (node as Memo<any>).pure) {
    reset(node as Computation<any>, true);
  } else if (node.owned) {
    for (i = node.owned.length - 1; i >= 0; i--) cleanNode(node.owned[i]);
    node.owned = null;
  }

  if (node.cleanups) {
    for (i = node.cleanups.length - 1; i >= 0; i--) node.cleanups[i]();
    node.cleanups = null;
  }
  if (Transition && Transition.running) (node as Computation<any>).tState = 0;
  else (node as Computation<any>).state = 0;
  IS_DEV && delete node.sourceMap;
}

function reset(node: Computation<any>, top?: boolean) {
  if (!top) {
    node.tState = 0;
    Transition!.disposed.add(node);
  }
  if (node.owned) {
    for (let i = 0; i < node.owned.length; i++) reset(node.owned[i]);
  }
}

function castError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(typeof err === "string" ? err : "Unknown error", { cause: err });
}

function runErrors(err: unknown, fns: ((err: any) => void)[], owner: Owner | null) {
  try {
    for (const f of fns) f(err);
  } catch (e) {
    handleError(e, (owner && owner.owner) || null);
  }
}

function handleError(err: unknown, owner = Owner) {
  const fns = ERROR && owner && owner.context && owner.context[ERROR];
  const error = castError(err);
  if (!fns) throw error;

  if (Effects)
    Effects.push({
      fn() {
        runErrors(error, fns, owner);
      },
      state: STALE
    } as unknown as Computation<any>);
  else runErrors(error, fns, owner);
}

function resolveChildren(children: JSX.Element | Accessor<any>): ResolvedChildren {
  if (typeof children === "function" && !children.length) return resolveChildren(children());
  if (Array.isArray(children)) {
    const results: any[] = [];
    for (let i = 0; i < children.length; i++) {
      const result = resolveChildren(children[i]);
      Array.isArray(result) ? results.push.apply(results, result) : results.push(result);
    }
    return results;
  }
  return children as ResolvedChildren;
}

function createProvider(id: symbol, options?: EffectOptions) {
  return function provider(props: FlowProps<{ value: unknown }>) {
    let res;
    createRenderEffect(
      () =>
        (res = untrack(() => {
          Owner!.context = { ...Owner!.context, [id]: props.value };
          return children(() => props.children);
        })),
      undefined,
      options
    );
    return res;
  };
}

type TODO = any;

/**
 * @deprecated since version 1.7.0 and will be removed in next major - use catchError instead
 * onError - run an effect whenever an error is thrown within the context of the child scopes
 * @param fn an error handler that receives the error
 *
 * * If the error is thrown again inside the error handler, it will trigger the next available parent handler
 *
 * @description https://www.solidjs.com/docs/latest/api#onerror | https://docs.solidjs.com/reference/reactive-utilities/catch-error
 */
export function onError(fn: (err: Error) => void): void {
  ERROR || (ERROR = Symbol("error"));
  if (Owner === null)
    IS_DEV &&
      console.warn("error handlers created outside a `createRoot` or `render` will never be run");
  else if (Owner.context === null || !Owner.context[ERROR]) {
    // terrible de-opt
    Owner.context = { ...Owner.context, [ERROR]: [fn] };
    mutateContext(Owner, ERROR, [fn]);
  } else Owner.context[ERROR].push(fn);
}

function mutateContext(o: Owner, key: symbol, value: any) {
  if (o.owned) {
    for (let i = 0; i < o.owned.length; i++) {
      if (o.owned[i].context === o.context) mutateContext(o.owned[i], key, value);
      if (!o.owned[i].context) {
        o.owned[i].context = o.context;
        mutateContext(o.owned[i], key, value);
      } else if (!o.owned[i].context[key]) {
        o.owned[i].context[key] = value;
        mutateContext(o.owned[i], key, value);
      }
    }
  }
}
