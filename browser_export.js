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
export async function browserExport(input, progress, signal) {
  let base;
  try { base = new URL(input.webhook.trim()); } catch { throw Error('Введите полный HTTPS-адрес входящего вебхука.'); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || !/^\/rest\/\d+\/[\w-]+\/?$/.test(base.pathname)) throw Error('Неверный формат вебхука: нужен https://портал/rest/USER/SECRET/.');
  base.pathname = base.pathname.replace(/\/?$/, '/');
  const origin = base.origin;
  const low = input.min_duration === '' ? null : Number(input.min_duration);
  const high = input.max_duration === '' ? null : Number(input.max_duration);
  if ([low, high].some(n => n !== null && (!Number.isInteger(n) || n < 0)) || low !== null && high !== null && low > high) throw Error('Проверьте диапазон длительности.');
  const since = dateBound(input.date_from), until = dateBound(input.date_to, true);
  if (since && until && since >= until) throw Error('Начало периода должно быть раньше окончания.');
  const callId = input.call.trim() ? parseCall(input.call.trim()) : null;
  const phoneFilter = input.phone.replace(/\D/g, '');
  if (input.phone.trim() && !phoneFilter) throw Error('Телефон должен содержать цифры.');
  let last = 0;
  async function api(method, params) {
    for (let attempt = 0; attempt <= 5; attempt++) {
      if (signal?.aborted) throw Error('Выгрузка остановлена.');
      await sleep(Math.max(0, 1000 - (Date.now() - last))); last = Date.now();
      let response;
      try {
        response = await fetch(base.href + method + '.json', {
          method: 'POST', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
          headers: {'Content-Type': 'application/x-www-form-urlencoded'},
          body: new URLSearchParams(flatten(params)), signal: AbortSignal.any([signal, AbortSignal.timeout(60000)].filter(Boolean))
        });
      } catch {
        if (signal?.aborted) throw Error('Выгрузка остановлена.');
        throw Error('Браузер не смог обратиться к Битрикс24. Возможны запрет CORS, сеть или тайм-аут. Используйте start_web.cmd для локального режима.');
      }
      let data; try { data = await response.json(); } catch { throw Error('Портал вернул ответ в неожиданном формате.'); }
      const retry = [429, 500, 502, 503, 504].includes(response.status) || ['QUERY_LIMIT_EXCEEDED', 'OPERATION_TIME_LIMIT', 'INTERNAL_SERVER_ERROR'].includes(data.error);
      if (retry && attempt < 5) { progress('Портал временно ограничил запросы. Повторяем…'); await sleep(Math.min(60000, 1000 * 2 ** attempt)); continue; }
      if (!response.ok || data.error) {
        // Raw server text can include sensitive information. Only fixed messages leave here.
        const error = Error('Запрос отклонён порталом. Проверьте вебхук, права CRM, телефонии и пользователей.');
        error.api = true; throw error;
      }
      if (!('result' in data)) throw Error('В ответе отсутствуют данные.');
      return data;
    }
  }
  async function* pages(method, params) {
    let start = 0; const seen = new Set();
    while (true) {
      if (seen.has(start)) throw Error('Портал повторяет страницу данных. Выгрузка остановлена.');
      seen.add(start);
      const d = await api(method, {...params, start});
      if (!Array.isArray(d.result)) throw Error('Портал вернул неожиданный список.');
      yield* d.result;
      if (d.next == null) break;
      start = Number(d.next);
      if (!Number.isSafeInteger(start) || start < 0) throw Error('Некорректная пагинация портала.');
    }
  }
  const users = new Map(); progress('Получаем список менеджеров…');
  for await (const u of pages('user.get', {sort: 'ID', order: 'ASC'})) users.set(String(u.ID), [u.LAST_NAME, u.NAME, u.SECOND_NAME].filter(Boolean).join(' '));
  const f = {TYPE_ID: 2};
  if (input.manager.trim()) {
    const tokens = input.manager.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const ids = [...users].filter(([, n]) => tokens.every(t => n.toLocaleLowerCase().includes(t))).map(([id]) => id);
    if (!ids.length) throw Error('Менеджер не найден. Проверьте ФИО и доступные права.');
    f.RESPONSIBLE_ID = ids;
  }
  if (since) f['>=START_TIME'] = since;
  if (until) f['<START_TIME'] = until;
  if (callId) f.ID = callId;
  const fields = ['activity_id','activity_url','manager_id','manager_name','start_time','phone','duration_seconds','duration_source','call_ids','record_file_ids','owner_type_id','owner_id','subject','transcript_status','error_code','transcription'];
  const lines = [fields.map(csvCell).join(';')];
  const seen = new Set(); let checked = 0, ready = 0, missing = 0, errors = 0;
  for await (const a of pages('crm.activity.list', {filter: f, order: {ID: 'ASC'}, select: ['*', 'COMMUNICATIONS']})) {
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
function flatten(object, prefix = '') {
  const entries = [];
  for (const [key, value] of Object.entries(object)) {
    const name = prefix ? `${prefix}[${key}]` : key;
    if (value !== null && typeof value === 'object') entries.push(...flatten(value, name));
    else entries.push([name, String(value)]);
  }
  return entries;
}
