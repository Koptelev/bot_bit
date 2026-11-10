/* Static GitHub Pages export. No credential persistence or third-party requests. */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function parseCall(value) {
  if (/^[1-9]\d*$/.test(value)) return value;
  let u; try { u = new URL(value); } catch { throw Error('Укажите ID CRM-дела или ссылку на дело.'); }
  const id = u.searchParams.get('activity_id') || u.searchParams.get('id') || u.pathname.match(/\/crm\/activity\/(?:details\/)?(\d+)/)?.[1];
  if (!/^https?:$/.test(u.protocol) || !u.pathname.startsWith('/crm/activity/') || !/^[1-9]\d*$/.test(id || '')) throw Error('Нужна ссылка на CRM-дело звонка, а не на сделку.');
  return id;
}
export function csvCell(value) {
  let s = String(value ?? '');
  if (/^[\s]*[=+@-]/.test(s) || /^[\t\r\n]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}
function dateBound(value, end = false) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw Error('Проверьте даты.');
  const d = new Date(value + 'T00:00:00+03:00');
  if (!Number.isFinite(d.getTime())) throw Error('Проверьте даты.');
  if (end) d.setTime(d.getTime() + 86400000);
  return d.toISOString();
}
export function createSession(webhook, transport = null) {
  let base;
  try { base = new URL(webhook.trim()); } catch { throw Error('Введите полный HTTPS-адрес входящего вебхука.'); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || !/^\/rest\/\d+\/[\w-]+\/?$/.test(base.pathname)) throw Error('Неверный формат вебхука: нужен https://портал/rest/USER/SECRET/.');
  base.pathname = base.pathname.replace(/\/?$/, '/');
  const origin = base.origin;
  let last = 0;
  let progress = () => {}, signal;
  let users = new Map(), cached = null;
  async function api(method, params) {
    if (transport) {
      await sleep(Math.max(0, 1000 - (Date.now() - last)));
      if (signal?.aborted) throw Error('Выгрузка остановлена.');
      last = Date.now();
      return transport(method, params, signal);
    }
    return directApi(method, params);
  }
  async function directApi(method, params) {
    for (let attempt = 0; attempt <= 5; attempt++) {
      if (signal?.aborted) throw Error('Выгрузка остановлена.');
      await sleep(Math.max(0, 1000 - (Date.now() - last))); last = Date.now();
      if (signal?.aborted) throw Error('Выгрузка остановлена.');
      let response;
      try {
        response = await fetch(base.href + method + '.json', {
          method: 'POST', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
          headers: {'Content-Type': 'application/x-www-form-urlencoded'},
          body: new URLSearchParams(flatten(params)), signal: AbortSignal.any([signal, AbortSignal.timeout(60000)].filter(Boolean))
        });
      } catch {
        if (signal?.aborted) throw Error('Выгрузка остановлена.');
        throw Error('Нет связи с Битрикс24. Возможны CORS, сеть или тайм-аут. Попробуйте локальный режим start_web.cmd.');
      }
      let data; try { data = await response.json(); } catch { throw Error('Портал вернул ответ в неожиданном формате.'); }
      const retry = [429, 500, 502, 503, 504].includes(response.status) || ['QUERY_LIMIT_EXCEEDED', 'OPERATION_TIME_LIMIT', 'INTERNAL_SERVER_ERROR'].includes(data.error);
      if (retry && attempt < 5) { progress('Портал временно ограничил запросы. Повторяем…'); await sleep(Math.min(60000, 1000 * 2 ** attempt)); continue; }
      if (!response.ok || data.error) {
        const error = Error('Запрос отклонён порталом. Проверьте вебхук и права CRM, телефонии и пользователей.');
        error.api = true; throw error;
      }
      if (!('result' in data)) throw Error('В ответе отсутствуют данные.');
      return data;
    }
  }
  async function* pages(method, params) {
    let start = 0; const seen = new Set();
    while (true) {
      if (seen.has(start)) throw Error('Портал повторяет страницу данных.');
      seen.add(start);
      const d = await api(method, {...params, start});
      if (!Array.isArray(d.result)) throw Error('Портал вернул неожиданный список.');
      yield* d.result;
      if (d.next == null) break;
      start = Number(d.next);
      if (!Number.isSafeInteger(start) || start < 0) throw Error('Некорректная пагинация портала.');
    }
  }
  return {
    async verify(onProgress = () => {}, abortSignal) {
      progress = onProgress; signal = abortSignal;
      users = new Map(); cached = null;
      progress('Проверяем подключение и доступ к списку сотрудников…');
      for await (const u of pages('user.get', {sort: 'ID', order: 'ASC'})) users.set(String(u.ID), [u.LAST_NAME, u.NAME, u.SECOND_NAME].filter(Boolean).join(' '));
      await api('crm.activity.list', {filter: {TYPE_ID: 2, ID: 0}, select: ['ID'], start: 0});
      await api('voximplant.statistic.get', {FILTER: {CRM_ACTIVITY_ID: 0}, start: 0});
      return {users: users.size};
    },
    async discover(input, onProgress = () => {}, abortSignal) {
      progress = onProgress; signal = abortSignal; cached = null;
      const since = dateBound(input.date_from), until = dateBound(input.date_to, true);
      if (!since || !until || since >= until) throw Error('Выберите корректный диапазон дат.');
      const calls = [], seen = new Set(), counts = new Map();
      const f = {TYPE_ID: 2, '>=START_TIME': since, '<START_TIME': until};
      for await (const a of pages('crm.activity.list', {filter: f, order: {ID: 'ASC'}, select: ['*', 'COMMUNICATIONS']})) {
        if (seen.has(String(a.ID))) continue;
        seen.add(String(a.ID)); calls.push(a);
        const id = String(a.RESPONSIBLE_ID || '');
        if (id && id !== '0') counts.set(id, (counts.get(id) || 0) + 1);
        progress(`Найдено звонков за период: ${calls.length}. Тексты расшифровок пока не запрашиваем.`);
      }
      cached = {key: `${input.date_from}|${input.date_to}`, calls};
      return [...counts].map(([id,count]) => ({id, count, name: users.get(id) || `Сотрудник #${id}`})).sort((a,b) => a.name.localeCompare(b.name, 'ru'));
    },
    async export(input, onProgress = () => {}, abortSignal) {
      progress = onProgress; signal = abortSignal;
      if (!cached || cached.key !== `${input.date_from}|${input.date_to}`) throw Error('Сначала загрузите менеджеров за выбранный период.');
      const selected = new Set((input.manager_ids || []).map(String));
      if (!selected.size) throw Error('Отметьте хотя бы одного менеджера.');
      const candidates = cached.calls.filter(a => selected.has(String(a.RESPONSIBLE_ID)));
      return runExport(input, candidates);
    }
  };
  async function runExport(input, candidates) {
  const low = input.min_duration === '' ? null : Number(input.min_duration);
  const high = input.max_duration === '' ? null : Number(input.max_duration);
  if ([low, high].some(n => n !== null && (!Number.isInteger(n) || n < 0)) || low !== null && high !== null && low > high) throw Error('Проверьте диапазон длительности.');
  const since = dateBound(input.date_from), until = dateBound(input.date_to, true);
  if (since && until && since >= until) throw Error('Начало периода должно быть раньше окончания.');
  const callId = input.call.trim() ? parseCall(input.call.trim()) : null;
  const phoneFilter = input.phone.replace(/\D/g, '');
  if (input.phone.trim() && !phoneFilter) throw Error('Телефон должен содержать цифры.');
  const fields = ['activity_id','activity_url','manager_id','manager_name','start_time','phone','duration_seconds','duration_source','call_ids','record_file_ids','owner_type_id','owner_id','subject','transcript_status','error_code','transcription'];
  const lines = [fields.map(csvCell).join(';')];
  const seen = new Set(); let checked = 0, ready = 0, missing = 0, errors = 0;
  for (const a of candidates) {
    if (callId && String(a.ID) !== String(callId)) continue;
    if (seen.has(String(a.ID))) continue; seen.add(String(a.ID)); checked++;
    progress(`Проверено звонков: ${checked}. С готовым текстом: ${ready}.`);
    const stats = []; for await (const s of pages('voximplant.statistic.get', {FILTER: {CRM_ACTIVITY_ID: a.ID}, SORT: 'ID', ORDER: 'ASC'})) stats.push(s);
    const phones = [...new Set([...stats.map(s => s.PHONE_NUMBER), ...(a.COMMUNICATIONS || []).filter(c => !c.TYPE || c.TYPE === 'PHONE').map(c => c.VALUE)].filter(Boolean))];
    if (phoneFilter && !phones.some(p => String(p).replace(/\D/g, '').includes(phoneFilter))) continue;
    const durations = stats.filter(s => s.CALL_DURATION != null && s.CALL_DURATION !== '').map(s => Number(s.CALL_DURATION)).filter(n => Number.isFinite(n) && n >= 0);
    const duration = durations.length ? Math.max(...durations) : null;
    if (low !== null && (duration === null || duration < low) || high !== null && (duration === null || duration > high)) continue;
    let transcript;
    try {
      const d = await api('crm.activity.call.getTranscript', {activityId: a.ID});
      transcript = d.result?.transcription;
      if (d.result !== null && typeof transcript !== 'string') throw Error('Неожиданный формат расшифровки.');
    } catch (e) { if (!e.api) throw e; errors++; continue; }
    if (!transcript?.trim()) { missing++; continue; }
    const row = [a.ID, `${origin}/crm/activity/?id=${a.ID}`, a.RESPONSIBLE_ID, users.get(String(a.RESPONSIBLE_ID)), a.START_TIME, phones.join(', '), duration, durations.length ? 'telephony_max_leg' : 'unknown', stats.map(s => s.CALL_ID || '').join(' | '), stats.map(s => s.RECORD_FILE_ID || '').join(' | '), a.OWNER_TYPE_ID, a.OWNER_ID, a.SUBJECT, 'ready', '', transcript];
    lines.push(row.map(csvCell).join(';')); ready++;
  }
  return {blob: new Blob(['\ufeff' + lines.join('\r\n') + '\r\n'], {type: 'text/csv;charset=utf-8'}), ready, checked, missing, errors};
  }
}
function flatten(object, prefix = '') {
  const entries = [];
  for (const [key, value] of Object.entries(object)) {
    const name = prefix ? `${prefix}[${key}]` : key;
    if (value !== null && typeof value === 'object') entries.push(...flatten(value, name));
    else entries.push([name, String(value)]);
  }
  return entries;
}
