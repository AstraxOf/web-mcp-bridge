const P = window.POPUP;
const { $, api, toast, guard, setBusy, openLink } = P;

export function renderNotices(state) {
  const data = state.notices ?? { items: [], unread: 0 };
  const badge = $('#notices-badge');
  badge.hidden = !data.unread;
  badge.textContent = data.unread > 9 ? '9+' : String(data.unread);

  const sig = JSON.stringify([data.items, data.checkedAt, data.error]);
  if (sig === P.noticesSig) return;
  P.noticesSig = sig;

  const list = $('#notice-list');
  list.replaceChildren();
  $('#notices-empty').hidden = data.items.length > 0;
  $('#read-all').hidden = !data.unread;

  for (const n of data.items) {
    const li = document.createElement('li');
    li.className = `notice ${n.level}${n.unread ? ' unread' : ''}`;
    const title = document.createElement('div');
    title.className = 'n-title';
    title.textContent = n.title;
    const date = document.createElement('div');
    date.className = 'n-date';
    date.textContent = [P.LEVEL_TEXT[n.level], n.date ? new Date(n.date).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' }) : null].filter(Boolean).join(' · ');
    li.append(title, date);
    if (n.message) {
      const msg = document.createElement('div');
      msg.className = 'n-msg';
      msg.textContent = n.message;
      li.append(msg);
    }
    const actions = document.createElement('div');
    actions.className = 'n-actions';
    if (n.url) {
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'primary small';
      open.textContent = 'View on GitHub';
      open.addEventListener('click', guard(async () => { openLink(n.url); await api('READ_NOTICES', { ids: [n.id] }); }));
      actions.append(open);
    }
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'soft small';
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', guard(() => api('DISMISS_NOTICE', { id: n.id })));
    actions.append(dismiss);
    li.append(actions);
    list.append(li);
  }

  const when = data.checkedAt
    ? `Checked ${new Date(data.checkedAt).toLocaleString('en', { dateStyle: 'short', timeStyle: 'short' })}`
    : 'Not checked yet';
  $('#notices-line').textContent = data.error ? `${data.error}` : when;
}

export function bindNoticesEvents() {
  $('#read-all').addEventListener('click', guard(() => api('READ_NOTICES', { ids: 'all' })));

  $('#check-notices').addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    setBusy(btn, true);
    try {
      const res = await api('CHECK_NOTICES');
      toast(res.count ? `${res.count} active notice${res.count === 1 ? '' : 's'}.` : 'No new notices.');
    } catch (err) { toast(err.message, 5000); }
    setBusy(btn, false);
    P.noticesSig = '';
    await P.refresh(true);
  });
}
