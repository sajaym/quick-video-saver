// Client for the local helper (Chrome native messaging).
import {uid} from './util.js';

export const HOST = 'com.quick_video_saver.local';
export const MIN_HELPER_MAJOR = 2;
const LONG = {probe: 130000, media_info: 60000, choose_folder: 600000, update: 300000};

export class HelperClient {
  constructor({onEvent, onState, getConfig}) {
    this.onEvent = onEvent;
    this.onState = onState;
    this.getConfig = getConfig;
    this.port = null;
    this.pending = new Map();
    this.connecting = null;
    this.lastFailure = 0;
    // status: unknown | connecting | ready | missing | forbidden | outdated | error
    this.info = {status: 'unknown', version: '', folder: '', tools: {}, impersonate: null, ready: false, error: ''};
  }

  set(patch) {
    this.info = {...this.info, ...patch};
    this.onState?.(this.info);
  }

  ensure(force = false) {
    if (this.port && this.info.status === 'ready') return Promise.resolve(this.info);
    if (this.connecting) return this.connecting;
    if (!force && ['missing', 'forbidden', 'outdated'].includes(this.info.status) && Date.now() - this.lastFailure < 4000) return Promise.reject(new Error(this.info.error));
    this.connecting = this.connect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async connect() {
    this.set({status: 'connecting', error: ''});
    let port;
    try { port = chrome.runtime.connectNative(HOST); }
    catch (error) { return this.fail('missing', error.message); }
    this.port = port;
    port.onMessage.addListener(message => this.receive(message));
    port.onDisconnect.addListener(() => this.disconnected(port));
    try {
      const config = await this.getConfig();
      const pong = await this.send('ping', {config}, 15000);
      if (parseInt(pong.version, 10) < MIN_HELPER_MAJOR || !pong.version) {
        // An older helper speaks an older protocol: say so instead of failing in confusing ways later.
        this.port = null;
        try { port.disconnect(); } catch { /* already closed */ }
        this.lastFailure = Date.now();
        this.set({status: 'outdated', ready: false, version: pong.version || '1', error: `The installed helper is version ${pong.version || '1'}. Run SETUP-WINDOWS.cmd from this package to update it.`});
        throw new Error(this.info.error);
      }
      this.set({status: 'ready', version: pong.version, folder: pong.folder, tools: pong.tools || {}, impersonate: pong.impersonate, ready: !!pong.ready, error: pong.configError || ''});
      return this.info;
    } catch (error) {
      if (this.port === port && this.info.status === 'connecting') this.fail('error', error.message);
      throw new Error(this.info.error || error.message);
    }
  }

  fail(status, message) {
    this.lastFailure = Date.now();
    this.port = null;
    this.set({status, ready: false, error: message || 'The helper could not be started.'});
    throw new Error(this.info.error);
  }

  disconnected(port) {
    const detail = chrome.runtime.lastError?.message || '';
    if (this.port !== port) return;
    this.port = null;
    const wasReady = this.info.status === 'ready';
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(detail || 'The helper stopped.')); }
    this.pending.clear();
    this.lastFailure = Date.now();
    if (/not found/i.test(detail)) this.set({status: 'missing', ready: false, error: 'Helper is not installed. Run SETUP-WINDOWS.cmd, then restart the browser.'});
    else if (/forbidden/i.test(detail)) this.set({status: 'forbidden', ready: false, error: 'The helper does not trust this extension. Run SETUP-WINDOWS.cmd again.'});
    else this.set({status: wasReady ? 'unknown' : 'error', ready: false, error: wasReady ? '' : detail || 'The helper stopped unexpectedly.'});
    this.onEvent?.({event: 'disconnected', error: detail});
  }

  receive(message) {
    if (message.requestId && this.pending.has(message.requestId)) {
      const entry = this.pending.get(message.requestId);
      clearTimeout(entry.timer);
      this.pending.delete(message.requestId);
      if (message.ok === false) {
        const error = new Error(message.error || 'The helper request failed.');
        error.code = message.errorCode;
        error.reply = message;
        entry.reject(error);
      } else entry.resolve(message);
      return;
    }
    if (message.event === 'tools') this.set({tools: message.tools || this.info.tools, impersonate: message.impersonate, ready: !!message.ready});
    this.onEvent?.(message);
  }

  send(type, data = {}, timeout = 20000) {
    return new Promise((resolve, reject) => {
      const requestId = uid();
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('The helper is not responding.')); }, timeout);
      this.pending.set(requestId, {resolve, reject, timer});
      try { this.port.postMessage({type, requestId, ...data}); }
      catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }

  async call(type, data = {}, timeout) {
    await this.ensure();
    return this.send(type, data, timeout || LONG[type] || 20000);
  }

  get ready() { return this.info.status === 'ready' && this.info.ready; }

  disconnect() { try { this.port?.disconnect(); } catch { /* already gone */ } this.port = null; }
}
