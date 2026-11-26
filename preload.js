const { contextBridge, ipcRenderer, webUtils } = require('electron');

const dataHandlers = new Map();
const exitHandlers = new Map();
// output for a pty whose pane is not attached yet (renderer reload): kept until onData is set
const pendingData = new Map();
ipcRenderer.on('pty:data', (_e, id, data, off) => {
  const h = dataHandlers.get(id);
  if (h) h(data, off);
  else { if (!pendingData.has(id)) pendingData.set(id, []); pendingData.get(id).push([data, off]); }
});
ipcRenderer.on('pty:exit', (_e, id, code) => {
  const h = exitHandlers.get(id);
  dataHandlers.delete(id); exitHandlers.delete(id); pendingData.delete(id);
  if (h) h(code);
});

let uiHandler = null;
ipcRenderer.on('ui:request', async (_e, reqId, payload) => {
  let res;
  try { res = uiHandler ? await uiHandler(payload) : { error: 'Oberfläche nicht bereit' }; }
  catch (err) { res = { error: String(err && err.message || err) }; }
  ipcRenderer.send('ui:response', reqId, res);
});

contextBridge.exposeInMainWorld('neko', {
  pty: {
    create: opts => ipcRenderer.invoke('pty:create', opts),
    write: (id, data) => ipcRenderer.send('pty:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
    kill: id => ipcRenderer.send('pty:kill', id),
    setCwd: (id, cwd) => ipcRenderer.send('pty:cwd', id, cwd),
    onData: (id, fn) => {
      dataHandlers.set(id, fn);
      const q = pendingData.get(id);
      if (q) { pendingData.delete(id); for (const [d, off] of q) fn(d, off); }
    },
    onExit: (id, fn) => { exitHandlers.set(id, fn); },
  },
  session: { restore: () => ipcRenderer.invoke('session:restore') },
  ui: {
    onRequest: fn => { uiHandler = fn; },
    onFocusPane: fn => { ipcRenderer.on('ui:focus-pane', (_e, id) => fn(id)); },
    notify: opts => ipcRenderer.send('ui:notify', opts),
  },
  app: {
    update: opts => ipcRenderer.invoke('app:update', opts),
    info: () => ipcRenderer.invoke('app:info'),
  },
  open: (target, cwd, opts) => ipcRenderer.invoke('open:target', target, cwd, opts),
  statMany: (cwd, list) => ipcRenderer.invoke('fs:stat-many', cwd, list),
  loadImage: (src, cwd) => ipcRenderer.invoke('img:load', src, cwd),
  pathForFile: file => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: patch => ipcRenderer.invoke('config:set', patch),
    open: () => ipcRenderer.invoke('config:open'),
    onChange: fn => { ipcRenderer.on('config:changed', (_e, cfg) => fn(cfg)); },
  },
  shells: () => ipcRenderer.invoke('shells:list'),
  history: {
    load: () => ipcRenderer.invoke('history:load'),
    append: line => ipcRenderer.send('history:append', line),
  },
  commands: () => ipcRenderer.invoke('commands:get'),
  completePath: (cwd, token, style) => ipcRenderer.invoke('fs:complete', cwd, token, style),
  clipboard: {
    read: () => ipcRenderer.invoke('clipboard:read'),
    write: t => ipcRenderer.send('clipboard:write', t),
    info: () => ipcRenderer.invoke('clipboard:info'),
    saveImage: () => ipcRenderer.invoke('clipboard:save-image'),
  },
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    resizeStart: edge => ipcRenderer.send('window:resize-start', edge),
    resizeStop: () => ipcRenderer.send('window:resize-stop'),
    onState: fn => { ipcRenderer.on('window:state', (_e, st) => fn(st)); },
    fullscreen: () => ipcRenderer.send('window:fullscreen'),
    close: () => ipcRenderer.send('window:close'),
    newWindow: () => ipcRenderer.send('window:new'),
  },
});
