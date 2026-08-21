/**
 * chrome.* 与 fetch 的测试替身。
 *
 * `src/background/` 里的模块在**导入时**就会读 `chrome.storage.local`（state.js 顶层），
 * 所以必须先 installChromeStub() 再 `await import()` 那些模块 —— 用动态导入而不是
 * 顶层 import 语句就是为了保证这个顺序。
 *
 * 替身只实现本项目真正用到的那几个 API，并把调用记录暴露出来，
 * 这样测试可以断言「有没有真的写代理设置」「PAC 内容是什么」「发了几次探测请求」。
 */

/** 极简 chrome.storage.StorageArea */
function makeArea() {
  let data = {};
  return {
    async get(keys) {
      if (keys == null) return { ...data };
      if (typeof keys === 'string') return { [keys]: data[keys] };
      if (Array.isArray(keys)) {
        const out = {};
        for (const key of keys) out[key] = data[key];
        return out;
      }
      return { ...data };
    },
    async set(obj) {
      data = { ...data, ...obj };
    },
    async remove(key) {
      const keys = Array.isArray(key) ? key : [key];
      for (const k of keys) delete data[k];
    },
    _dump: () => data,
    _clear: () => {
      data = {};
    },
  };
}

function makeEvent(bucket) {
  return {
    addListener: (fn, ...rest) => bucket.push({ fn, args: rest }),
  };
}

/**
 * 安装替身到 globalThis，返回可供断言与调整的把手。
 */
export function installChromeStub() {
  const local = makeArea();
  const session = makeArea();

  /** chrome.proxy.settings 的调用记录 */
  const proxyCalls = [];
  /** 已注册的定时任务 */
  const alarms = new Map();
  /** 各事件的监听器 */
  const listeners = {
    onMessage: [],
    onInstalled: [],
    onStartup: [],
    onAlarm: [],
    onBeforeRequest: [],
    onCompleted: [],
    onErrorOccurred: [],
    onAuthRequired: [],
  };
  /** 探测请求记录 */
  const fetchCalls = [];

  let levelOfControl = 'controlled_by_this_extension';
  let settingsValue = { mode: 'direct' };
  let settingsThrows = null;
  let fetchImpl = async () => ({ ok: true, status: 204 });

  globalThis.chrome = {
    storage: { local, session },

    proxy: {
      settings: {
        async set(details) {
          proxyCalls.push({ type: 'set', ...details });
          if (settingsThrows) throw new Error(settingsThrows);
          settingsValue = details.value;
        },
        async clear(details) {
          proxyCalls.push({ type: 'clear', ...details });
          settingsValue = { mode: 'direct' };
        },
        async get() {
          return { levelOfControl, value: settingsValue };
        },
      },
    },

    alarms: {
      async create(name, info) {
        alarms.set(name, info);
      },
      async clear(name) {
        return alarms.delete(name);
      },
      onAlarm: makeEvent(listeners.onAlarm),
    },

    runtime: {
      onMessage: makeEvent(listeners.onMessage),
      onInstalled: makeEvent(listeners.onInstalled),
      onStartup: makeEvent(listeners.onStartup),
    },

    webRequest: {
      onBeforeRequest: makeEvent(listeners.onBeforeRequest),
      onCompleted: makeEvent(listeners.onCompleted),
      onErrorOccurred: makeEvent(listeners.onErrorOccurred),
      onAuthRequired: makeEvent(listeners.onAuthRequired),
    },
  };

  globalThis.fetch = (url, options) => {
    fetchCalls.push(String(url));
    return fetchImpl(url, options);
  };

  return {
    local,
    session,
    proxyCalls,
    alarms,
    listeners,
    fetchCalls,

    /** 清掉调用记录与存储，但保留已注册的监听器（它们只在 install 时注册一次） */
    reset() {
      local._clear();
      session._clear();
      proxyCalls.length = 0;
      fetchCalls.length = 0;
      alarms.clear();
      levelOfControl = 'controlled_by_this_extension';
      settingsValue = { mode: 'direct' };
      settingsThrows = null;
      fetchImpl = async () => ({ ok: true, status: 204 });
    },

    setControl(value) {
      levelOfControl = value;
    },
    setSettingsError(message) {
      settingsThrows = message;
    },
    setFetch(fn) {
      fetchImpl = fn;
    },

    /** 最近一次成功注入的 PAC 脚本源码；没注入过则为 null */
    lastPac() {
      const sets = proxyCalls.filter((c) => c.type === 'set');
      return sets.length ? sets[sets.length - 1].value?.pacScript?.data ?? null : null;
    },
    lastSet() {
      const sets = proxyCalls.filter((c) => c.type === 'set');
      return sets.length ? sets[sets.length - 1] : null;
    },
    /** 触发某个 webRequest 事件的全部监听器 */
    async emit(event, ...args) {
      for (const entry of listeners[event]) await entry.fn(...args);
    },
  };
}

/** 造一个可被 normalizeConfig 直接接受的节点 */
export function nodeFixture(id, overrides = {}) {
  return {
    id,
    name: id,
    protocol: 'http',
    host: `${id.slice(2)}.px`,
    port: 8080,
    username: '',
    password: '',
    enabled: true,
    autoDisabled: false,
    raw: '',
    meta: {},
    ...overrides,
  };
}
