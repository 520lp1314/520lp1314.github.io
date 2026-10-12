(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.BeadBluetoothDiagnostic = api; api.mount(root); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const BASE = '-0000-1000-8000-00805f9b34fb';
  const standardUuid = hex => hex.padStart(8, '0') + BASE;
  const STANDARD_SERVICES = [standardUuid('180a'), standardUuid('180f')];
  const PRIVATE_CHARACTERISTICS = new Set(['2a23', '2a25'].map(standardUuid));
  const TEXT_CHARACTERISTICS = new Set(['2a24', '2a26', '2a27', '2a28', '2a29'].map(standardUuid));
  const PROPERTY_NAMES = ['read', 'write', 'writeWithoutResponse', 'notify', 'indicate', 'broadcast', 'authenticatedSignedWrites', 'reliableWrite', 'writableAuxiliaries'];
  const UUID_LABELS = Object.fromEntries([
    ['180a', '设备信息'], ['180f', '电量'], ['2a19', '电量百分比'], ['2a24', '型号'],
    ['2a26', '固件版本'], ['2a27', '硬件版本'], ['2a28', '软件版本'], ['2a29', '制造商'],
    ['2a23', '系统标识（不读取）'], ['2a25', '设备序列号（不读取）']
  ].map(([hex, label]) => [standardUuid(hex), label]));

  function parseServices(input) {
    if (typeof input !== 'string' || input.length > 3000) throw new Error('服务编号过长，请一次最多填写 32 个服务 UUID。');
    const tokens = input.trim().split(/[\s,;，；、]+/).filter(Boolean);
    if (tokens.length > 32) throw new Error('请一次最多填写 32 个服务 UUID。');
    return [...new Set(tokens.map(token => {
      let value = token.toLowerCase().replace(/^0x/, '');
      if (/^[0-9a-f]{4}$/.test(value) || /^[0-9a-f]{8}$/.test(value)) value = standardUuid(value);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
        throw new Error('服务 UUID 格式不正确。请复制扫描工具中的 Service UUID，每行一个；不要填写设备名称。');
      }
      return value;
    }))];
  }

  function errorText(error, context) {
    if (error?.name === 'NotFoundError') return context === 'choose' ? '已取消选择，或没有选中设备。可以重新点击连接。' : '当前获授权范围内未找到该服务或特征。';
    if (error?.name === 'SecurityError') return '没有取得该服务的访问权限。请填写它的 Service UUID，断开后重新点击连接授权。';
    if (error?.name === 'NotAllowedError') return '蓝牙访问未获允许。请检查 Chrome 的网站权限和手机蓝牙权限。';
    if (error?.name === 'NotSupportedError') return '当前设备或浏览器不支持这项蓝牙操作。';
    if (error?.name === 'NetworkError') return '蓝牙通信失败。请靠近豆板，确认豆板已开机，并让拼个豆豆断开连接后重试。';
    return String(error?.message || '操作未完成，请断开后重试。').slice(0, 500);
  }

  class Diagnostic {
    constructor(options = {}) {
      this.bluetooth = options.bluetooth;
      this.secure = options.secure !== false;
      this.onChange = options.onChange || (() => {});
      this.timeoutMs = options.timeoutMs || 15000;
      this.setTimer = options.setTimer || setTimeout;
      this.clearTimer = options.clearTimer || clearTimeout;
      this.now = options.now || (() => new Date().toISOString());
      this.device = null;
      this.server = null;
      this.listener = null;
      this.references = new Map();
      this.epoch = 0;
      this.pendingConnect = false;
      this.state = {
        supported: this.secure && typeof this.bluetooth?.requestDevice === 'function',
        phase: 'idle', busy: false, deviceName: '', connected: false,
        message: '尚未连接。请给豆板通电，然后点击连接。',
        requestedServices: [...STANDARD_SERVICES], services: [], logs: []
      };
    }
    change() { this.onChange(this.state); }
    log(action, message) {
      this.state.logs.push({ time: this.now(), action, message: String(message).slice(0, 500) });
      this.state.logs = this.state.logs.slice(-100);
      this.change();
    }
    live(epoch) { return epoch === this.epoch && this.device?.gatt?.connected; }
    detach() {
      if (this.listener && this.device) this.device.removeEventListener('gattserverdisconnected', this.listener);
      this.listener = null;
    }
    drop(message, phase = 'idle') {
      const device = this.device;
      this.detach();
      this.epoch++;
      this.device = null;
      this.server = null;
      this.references.clear();
      this.state.connected = false;
      this.state.busy = false;
      this.state.phase = phase;
      this.state.message = message;
      try { device?.gatt?.disconnect(); } catch (_) { /* Already disconnected. */ }
      this.change();
    }
    disconnect() {
      if (this.state.phase === 'selecting') return;
      this.drop('已断开。服务列表保留为上次诊断记录，重新连接会重新读取。');
      this.log('disconnect', '用户断开连接');
    }
    deadline(promise, epoch, connectDevice) {
      // Keep the device's unfinished connection attempt isolated, even after a manual disconnect.
      if (connectDevice) this.pendingConnect = true;
      return new Promise((resolve, reject) => {
        let settled = false;
        let timedOut = false;
        const timer = this.setTimer(() => {
          settled = true;
          timedOut = true;
          if (epoch !== this.epoch) {
            const error = new Error('旧连接的操作已结束，结果已丢弃。');
            error.name = 'AbortError';
            reject(error);
            return;
          }
          const error = new Error('蓝牙操作超时，连接已断开。请确认豆板没有被其他程序占用后重试。');
          error.name = 'TimeoutError';
          this.drop(error.message, 'error');
          this.log('timeout', error.message);
          reject(error);
        }, this.timeoutMs);
        Promise.resolve(promise).then(value => {
          if (settled) {
            if (timedOut && connectDevice) {
              try { connectDevice.gatt.disconnect(); } catch (_) { /* Late connection cleanup. */ }
              this.pendingConnect = false;
              this.change();
            }
            return;
          }
          settled = true;
          this.clearTimer(timer);
          if (epoch !== this.epoch) {
            if (connectDevice) { try { connectDevice.gatt.disconnect(); } catch (_) {} }
            if (connectDevice) { this.pendingConnect = false; this.change(); }
            const error = new Error('本次连接已断开，旧操作结果已丢弃。');
            error.name = 'AbortError';
            reject(error);
          } else {
            if (connectDevice) this.pendingConnect = false;
            resolve(value);
          }
        }, error => {
          if (settled) {
            if (timedOut && connectDevice) { this.pendingConnect = false; this.change(); }
            return;
          }
          settled = true;
          this.clearTimer(timer);
          if (connectDevice) this.pendingConnect = false;
          reject(error);
        });
      });
    }
    async connect(input = '') {
      if (!this.state.supported) {
        this.state.message = !this.secure ? '请使用 HTTPS 测试网址；普通 HTTP 地址无法使用网页蓝牙。' : '当前浏览器没有网页蓝牙接口，请在安卓 Chrome 中打开测试网址。';
        this.change(); return;
      }
      if (this.state.busy || this.state.connected || this.pendingConnect) return;
      let requested;
      try { requested = [...new Set([...STANDARD_SERVICES, ...parseServices(input)])]; }
      catch (error) { this.state.message = errorText(error); this.log('input-error', this.state.message); return; }
      const epoch = ++this.epoch;
      this.state.services = [];
      this.references.clear();
      this.state.deviceName = '';
      this.state.requestedServices = requested;
      this.state.phase = 'selecting';
      this.state.busy = true;
      this.state.message = '请在 Chrome 的设备选择窗口中选中你的豆板。';
      this.change();
      let context = 'choose';
      try {
        // Invoke directly from the user's click; no asynchronous step precedes requestDevice.
        const device = await this.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: requested });
        if (epoch !== this.epoch) return;
        if (!device.gatt) throw new Error('选中的设备未提供可用的 BLE GATT 连接。');
        this.device = device;
        this.state.deviceName = String(device.name || '未命名蓝牙设备').slice(0, 160);
        this.listener = () => {
          if (this.device !== device) return;
          this.drop('豆板连接已断开。请检查电源和距离，再重新连接。', 'disconnected');
          this.log('disconnected', '设备断开，旧服务引用已清除');
        };
        device.addEventListener('gattserverdisconnected', this.listener);
        this.state.phase = 'connecting';
        this.state.message = '正在建立蓝牙连接…';
        this.change();
        context = 'connect';
        this.server = await this.deadline(device.gatt.connect(), epoch, device);
        if (!this.live(epoch)) throw new Error('设备未保持连接，请确认豆板电源和蓝牙状态。');
        this.state.connected = true;
        this.state.phase = 'connected';
        this.log('connected', '蓝牙已连接；尚未验证点灯指令');
        context = 'services';
        await this.enumerate(epoch);
      } catch (error) {
        if (epoch === this.epoch) {
          const message = errorText(error, context);
          this.drop(message, error?.name === 'NotFoundError' && context === 'choose' ? 'idle' : 'error');
          this.log('error', message);
        }
      } finally {
        if (epoch === this.epoch) { this.state.busy = false; this.change(); }
      }
    }
    async enumerate(epoch) {
      this.state.message = '已连接，正在读取获授权的服务与特征…';
      this.change();
      let services;
      try { services = await this.deadline(this.server.getPrimaryServices(), epoch); }
      catch (error) {
        if ((error?.name === 'NotFoundError' || error?.name === 'SecurityError') && this.live(epoch)) {
          this.state.message = '蓝牙已连接，但当前授权范围内没有读到服务。需要厂商 Service UUID，再断开重新授权。';
          this.log('service-permission', errorText(error, 'services'));
          return;
        }
        throw error;
      }
      if (!this.live(epoch)) return;
      this.state.services = [];
      this.references.clear();
      for (const [serviceIndex, service] of services.entries()) {
        if (!this.live(epoch)) return;
        const record = { uuid: String(service.uuid), primary: Boolean(service.isPrimary), characteristics: [] };
        this.state.services.push(record);
        try {
          const characteristics = await this.deadline(service.getCharacteristics(), epoch);
          if (!this.live(epoch)) return;
          for (const [charIndex, characteristic] of characteristics.entries()) {
            const key = `${serviceIndex}:${charIndex}`;
            const props = PROPERTY_NAMES.filter(name => characteristic.properties?.[name]);
            record.characteristics.push({ key, uuid: String(characteristic.uuid), properties: props, reading: null });
            this.references.set(key, characteristic);
          }
        } catch (error) {
          if (!this.live(epoch)) throw error;
          if (!['NotFoundError', 'SecurityError', 'NotSupportedError'].includes(error?.name)) throw error;
          record.error = errorText(error, 'characteristics');
          this.log('service-error', record.error);
        }
        this.change();
      }
      this.state.message = this.state.services.length ? '蓝牙已连接，获授权的服务已读取。现在可以导出诊断；本工具尚不发送点灯指令。' : '蓝牙已连接，但当前授权范围内没有读到服务。需要厂商 Service UUID，再断开重新授权。';
      this.log('services', `读取到 ${this.state.services.length} 个获授权可见服务`);
    }
    async refresh() {
      if (this.state.busy || !this.state.connected) return;
      const epoch = this.epoch;
      this.state.busy = true;
      try { await this.enumerate(epoch); }
      catch (error) { if (epoch === this.epoch) { const message = errorText(error, 'services'); this.drop(message, 'error'); this.log('error', message); } }
      finally { if (epoch === this.epoch) { this.state.busy = false; this.change(); } }
    }
    async read(key) {
      if (this.state.busy || !this.state.connected) return;
      const record = this.state.services.flatMap(service => service.characteristics).find(item => item.key === key);
      const characteristic = this.references.get(key);
      if (!record || !characteristic || !record.properties.includes('read') || PRIVATE_CHARACTERISTICS.has(record.uuid)) return;
      const epoch = this.epoch;
      this.state.busy = true;
      this.state.message = '正在读取所选特征…';
      this.change();
      try {
        const view = await this.deadline(characteristic.readValue(), epoch);
        if (!this.live(epoch)) return;
        const length = view.byteLength;
        const bytes = new Uint8Array(view.buffer, view.byteOffset, Math.min(length, 256));
        const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(' ');
        let text = '';
        if (record.uuid === standardUuid('2a19') && length) text = `${view.getUint8(0)}%`;
        else if (TEXT_CHARACTERISTICS.has(record.uuid)) text = new TextDecoder().decode(bytes).replace(/\x00/g, '').slice(0, 256);
        record.reading = { time: this.now(), byteLength: length, hex, text, truncated: length > bytes.length };
        delete record.readError;
        this.state.message = '所选特征已读取。可以导出诊断信息，连接成功仍不代表已能控制灯光。';
        this.log('read', `手动读取 ${record.uuid}，${length} 字节`);
      } catch (error) {
        if (epoch === this.epoch) {
          const message = errorText(error, 'read');
          record.readError = message;
          if (error?.name === 'NetworkError' || !this.device?.gatt?.connected) this.drop(message, 'error');
          else { this.state.message = message; this.log('read-error', message); }
        }
      } finally { if (epoch === this.epoch) { this.state.busy = false; this.change(); } }
    }
    clearLog() { this.state.logs = []; this.change(); }
    report() {
      return JSON.parse(JSON.stringify({
        format: 'bead-workshop-ble-diagnostic', version: 1, createdAt: this.now(),
        target: { model: '松鼠家第四代智能豆板（用户提供，尚未由设备验证）', cols: 104, rows: 104, companion: '拼个豆豆' },
        environment: { secureContext: this.secure, webBluetoothPresent: typeof this.bluetooth?.requestDevice === 'function' },
        scope: '只读诊断；仅获授权可见服务；未写入命令、未订阅通知、未验证灯光协议',
        connection: { phase: this.state.phase, connected: this.state.connected, deviceName: this.state.deviceName, message: this.state.message },
        requestedServices: this.state.requestedServices, services: this.state.services, events: this.state.logs
      }));
    }
  }

  function mount(win) {
    const doc = win.document;
    if (!doc?.getElementById('connectButton')) return;
    const el = id => doc.getElementById(id);
    const make = (tag, className, text) => { const node = doc.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
    const names = { read: '可读取', write: '可写入', writeWithoutResponse: '可无应答写入', notify: '可通知', indicate: '可指示' };
    const tool = new Diagnostic({ bluetooth: win.navigator.bluetooth, secure: win.isSecureContext, onChange: render });
    function render(state) {
      const capable = state.supported;
      el('capability').textContent = capable ? '浏览器具备网页蓝牙接口，可以开始实物连接测试。' : !win.isSecureContext ? '当前不是安全网址。请在安卓 Chrome 中打开 HTTPS 测试网址。' : /MicroMessenger/i.test(win.navigator.userAgent) ? '请复制测试网址，到安卓 Chrome 中打开；微信内网页无法使用这里需要的蓝牙接口。' : '当前浏览器没有网页蓝牙接口。请用安卓 Chrome 打开；苹果常用浏览器暂不支持此测试。';
      el('capability').dataset.available = String(capable);
      el('connectionStatus').textContent = state.message + (tool.pendingConnect ? ' 上次连接仍在结束；若按钮未恢复，请关闭豆板蓝牙或刷新页面。' : '');
      el('connectionStatus').dataset.phase = state.phase;
      el('deviceName').textContent = state.deviceName || '尚未选择设备';
      el('connectButton').disabled = !capable || state.busy || state.connected || tool.pendingConnect;
      el('connectButton').textContent = state.phase === 'selecting' ? '等待选择设备…' : state.phase === 'connecting' ? '正在连接…' : '选择并连接豆板';
      el('disconnectButton').disabled = !state.connected && state.phase !== 'connecting';
      el('refreshButton').disabled = !state.connected || state.busy;
      el('serviceUuids').disabled = state.busy || state.connected;
      el('serviceSummary').textContent = `${state.services.length} 个获授权可见服务${state.services.length && !state.connected ? '（上次连接记录）' : ''} · 尚未验证灯光控制`;
      const cards = [];
      for (const service of state.services) {
        const card = make('section', 'service-card');
        card.append(make('h3', 'service-heading', UUID_LABELS[service.uuid] || '蓝牙服务'), make('code', 'service-uuid', service.uuid));
        if (service.error) card.append(make('p', 'read-result', service.error));
        for (const record of service.characteristics) {
          const item = make('div', 'characteristic');
          item.append(make('h4', 'characteristic-heading', UUID_LABELS[record.uuid] || '特征'), make('code', 'characteristic-uuid', record.uuid));
          const props = make('div', 'property-list');
          for (const prop of record.properties) props.append(make('span', 'property-tag', names[prop] || prop));
          item.append(props);
          if (record.properties.includes('read') && !PRIVATE_CHARACTERISTICS.has(record.uuid)) {
            const button = make('button', 'read-button', '读取此特征');
            button.type = 'button'; button.disabled = state.busy || !state.connected;
            button.addEventListener('click', () => tool.read(record.key));
            item.append(button);
          }
          if (record.reading) item.append(make('pre', 'read-result', [record.reading.text, `${record.reading.byteLength} 字节${record.reading.truncated ? '（仅显示前 256 字节）' : ''}`, record.reading.hex || '空值'].filter(Boolean).join('\n')));
          if (record.readError) item.append(make('p', 'read-result', record.readError));
          card.append(item);
        }
        cards.push(card);
      }
      if (!cards.length) cards.push(make('p', 'empty-state', state.connected ? '当前授权范围内没有读到服务。展开“厂商服务编号”，填写扫描得到的 Service UUID，断开后重新连接。' : '连接后，这里显示获授权的服务和特征。'));
      el('services').replaceChildren(...cards);
      const entries = state.logs.map(entry => make('li', '', `${new Date(entry.time).toLocaleTimeString('zh-CN')} · ${entry.message}`));
      el('eventLog').replaceChildren(...entries);
    }
    function download() {
      const url = win.URL.createObjectURL(new Blob([JSON.stringify(tool.report(), null, 2)], { type: 'application/json' }));
      const anchor = make('a'); anchor.href = url; anchor.download = `松鼠豆板-安卓连接诊断-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      doc.body.append(anchor); anchor.click(); anchor.remove(); win.setTimeout(() => win.URL.revokeObjectURL(url), 1500);
    }
    el('connectButton').addEventListener('click', () => tool.connect(el('serviceUuids').value));
    el('refreshButton').addEventListener('click', () => tool.refresh());
    el('disconnectButton').addEventListener('click', () => tool.disconnect());
    el('exportButton').addEventListener('click', download);
    el('copyButton').addEventListener('click', async () => {
      try {
        if (!win.navigator.clipboard?.writeText) throw new Error('当前浏览器不能复制，请使用“导出诊断”保存文件。');
        await win.navigator.clipboard.writeText(JSON.stringify(tool.report(), null, 2));
        tool.log('copy', '诊断信息已复制');
      } catch (error) { tool.log('copy-error', errorText(error)); }
    });
    el('clearLogButton').addEventListener('click', () => tool.clearLog());
    win.addEventListener('pagehide', () => tool.disconnect());
    render(tool.state);
  }
  return { Diagnostic, parseServices, STANDARD_SERVICES, mount };
});
