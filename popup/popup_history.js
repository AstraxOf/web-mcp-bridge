const P = window.POPUP;
const { $, api, guard } = P;

export async function renderHistory() {
  const { history } = await api('GET_HISTORY');
  const sig = JSON.stringify(history);
  if (sig === P.historySig) return;
  P.historySig = sig;
  const list = $('#history-list');
  list.replaceChildren();
  $('#history-empty').hidden = history.length > 0;
  history.forEach((h, index) => {
    const li = document.createElement('li');
    li.style.setProperty('--i', Math.min(index, 10));
    const row = document.createElement('div');
    row.className = 'row';
    const title = document.createElement('span');
    title.textContent = `${h.server} · ${h.tool}`;
    const status = document.createElement('span');
    status.className = h.status;
    status.textContent = h.status === 'ok' ? `OK${h.ms ? ` · ${h.ms} ms` : ''}` : 'Error';
    row.append(title, status);
    const detail = document.createElement('small');
    detail.textContent = `${new Date(h.ts).toLocaleTimeString('en')} · ${h.error ?? h.args}`;
    li.append(row, detail);
    list.append(li);
  });
}

export function bindHistoryEvents() {
  $('#clear-history').addEventListener('click', guard(async () => {
    await api('CLEAR_HISTORY');
    P.historySig = '';
  }));
}
