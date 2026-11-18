'use strict';

window.createIslandOnline = function createIslandOnline() {
  let token = '';

  async function request(
    path,
    body,
    method = body === undefined ? 'GET' : 'POST',
  ) {
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch('/api/' + path, {
      method,
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error || 'Online service unavailable');
      error.status = response.status;
      throw error;
    }
    return data;
  }

  return {
    request,
    async signIn(mode, credentials) {
      const session = await request(mode, credentials);
      token = session.token;
      return session.user;
    },
    async signOut() {
      try {
        await request('logout', {});
      } finally {
        token = '';
      }
    },
  };
};

window.mountIslandAdmin = function mountIslandAdmin(
  panel,
  request,
  assets,
  events,
) {
  const body = document.createElement('div');
  body.innerHTML = `
    <div class="overlayHead"><h2>ONLINE ADMIN</h2><button id="onlineAdminClose" type="button">CLOSE</button></div>
    <p id="onlineAdminStatus" role="status"></p>
    <form data-action="notice"><h3>Bulletin</h3><label>Message <textarea name="message" required maxlength="400"></textarea></label><button>Publish</button></form>
    <div id="onlineNotices"></div>
    <form data-action="search"><h3>Accounts</h3><label>Username prefix <input name="username" maxlength="16"></label><button>Find accounts</button></form>
    <div id="onlineAccounts"></div>
    <form data-action="role" data-owner><label>Username <input name="username" required maxlength="16"></label><label>Role <select name="role"><option value="admin">Admin</option><option value="player">Player</option></select></label><button>Update role</button></form>
    <form data-action="invite" data-owner><label>Username <input name="username" required maxlength="16"></label><button>Create 24-hour admin invitation</button><output name="invitationCode"></output></form>
    <form data-action="gift"><h3>Player grants</h3><label>Username <input name="username" required maxlength="16"></label><label>Reward <select name="reward"></select></label><label>Amount <input name="qty" type="number" required min="1" max="1000000" value="1"></label><button name="change" value="give">Give</button><button name="change" value="take">Remove</button></form>
    <form data-action="code"><h3>Redeem codes</h3><label>Code <input name="code" required pattern="(?:[A-Za-z0-9_]|-){4,24}" maxlength="24"></label><label>Reward <select name="reward"></select></label><label>Amount <input name="qty" type="number" required min="1" max="1000000" value="1"></label><label>Max uses <input name="maxUses" type="number" required min="1" max="10000" value="10"></label><label>Hours <input name="hours" type="number" required min="0.25" max="8760" step="0.25" value="24"></label><button>Create code</button></form>
    <div id="onlineCodes"></div>
    <form data-action="vault" data-owner><h3>Shared vault</h3><label>Prize <select name="reward"></select></label><label>Amount <input name="qty" type="number" required min="1" max="1000000" value="25000"></label><label>Hours <input name="hours" type="number" required min="0.25" max="8760" step="0.25" value="24"></label><button>Open new vault</button><output name="vaultCode"></output></form>
    <form data-action="event"><h3>Global event</h3><label>Event <select name="event"></select></label><button name="active" value="true">Enable</button><button name="active" value="false">End</button></form>
    <form data-action="shutdown"><h3>Temporary shutdown</h3><label>Message <input name="message" maxlength="200"></label><button name="active" value="true">Pause game</button><button name="active" value="false">Resume game</button></form>
    <h3>Reports and admin applications</h3><div id="onlineInbox"></div>`;
  body
    .querySelectorAll('form')
    .forEach((form) => form.classList.add('vaultFields'));
  body.querySelectorAll('[name=reward]').forEach((select) => {
    for (const { asset, item, label } of assets) {
      if (
        select.form.dataset.action === 'vault' &&
        !['gold', 'tokens', 'skin', 'pet', 'trail'].includes(asset)
      )
        continue;
      select.add(new Option(label, [asset, item].join(':')));
    }
  });
  for (const [id, event] of Object.entries(events)) {
    body.querySelector('[name=event]').add(new Option(event.name, id));
  }
  const status = body.querySelector('#onlineAdminStatus');
  const list = (id, rows, label, action) => {
    const container = body.querySelector('#' + id);
    container.replaceChildren();
    for (const row of rows) {
      const line = document.createElement('p');
      line.textContent = label(row);
      if (action) {
        const [title, work] = action(row);
        const button = document.createElement('button');
        button.textContent = title;
        button.onclick = () => run(button, work);
        line.append(' ', button);
      }
      container.append(line);
    }
    if (!rows.length) container.textContent = 'No entries.';
  };
  const inbox = async () => {
    const { reports } = await request('admin/reports');
    list(
      'onlineInbox',
      reports,
      (row) => row.username + ' · ' + row.kind + ' · ' + row.message,
      (row) => {
        const closed = row.status === 'resolved';
        return [
          closed ? 'Reopen' : 'Resolve',
          async () => {
            await request('admin/reports/' + row.id + '/status', {
              status: closed ? 'open' : 'resolved',
            });
            await inbox();
          },
        ];
      },
    );
  };
  const notices = async () => {
    const { notices } = await request('notices');
    list(
      'onlineNotices',
      notices,
      (row) => row.message,
      (row) => [
        'Remove',
        async () => {
          await request('admin/notices/' + row.id, undefined, 'DELETE');
          await refresh();
        },
      ],
    );
  };
  const codes = async () => {
    const { codes } = await request('admin/codes');
    list(
      'onlineCodes',
      codes,
      (row) =>
        row.code +
        ' · ' +
        row.uses +
        '/' +
        row.max_uses +
        ' uses · expires ' +
        new Date(row.expires_at).toLocaleString(),
      (row) => [
        'Disable',
        async () => {
          await request('admin/codes/' + row.code, undefined, 'DELETE');
          await codes();
        },
      ],
    );
  };
  const refresh = () => Promise.all([inbox(), notices(), codes()]);
  async function run(button, work) {
    if (button.disabled) return;
    button.disabled = true;
    status.textContent = 'Working…';
    try {
      await work();
      status.textContent = 'Saved.';
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }
  body.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.target;
    const button = event.submitter;
    if (!button) return;
    const fields = Object.fromEntries(new FormData(form, button));
    const [asset, item] = (fields.reward || ':').split(':');
    const qty = Number(fields.qty);
    run(button, async () => {
      switch (form.dataset.action) {
        case 'search': {
          const { users } = await request(
            'admin/users?q=' + encodeURIComponent(fields.username.trim()),
          );
          list(
            'onlineAccounts',
            users,
            (row) => row.username + ' · ' + row.role,
          );
          break;
        }
        case 'notice':
          await request('admin/notices', { message: fields.message });
          form.reset();
          await notices();
          break;
        case 'role':
          await request('admin/role', fields);
          break;
        case 'invite': {
          const { code } = await request('admin/invitations', fields);
          form.elements.invitationCode.textContent =
            'Share this code with ' + fields.username + ': ' + code;
          break;
        }
        case 'gift':
          await request('admin/gift', {
            username: fields.username,
            asset,
            item,
            qty: fields.change === 'take' ? -qty : qty,
          });
          break;
        case 'code':
          await request('admin/codes', {
            asset,
            item,
            qty,
            code: fields.code,
            maxUses: Number(fields.maxUses),
            hours: Number(fields.hours),
          });
          await codes();
          break;
        case 'vault': {
          if (!confirm('Open a new shared vault and close the previous vault?'))
            return;
          const { code } = await request('admin/vault', {
            asset,
            item,
            qty,
            hours: Number(fields.hours),
          });
          form.elements.vaultCode.textContent =
            'Share this single-use code with the intended player: ' + code;
          break;
        }
        case 'event':
        case 'shutdown':
          await request('admin/state', {
            key: form.dataset.action,
            value: {
              active: fields.active === 'true',
              message: fields.message || '',
              event: fields.event,
              id: crypto.randomUUID(),
            },
          });
          break;
      }
    });
  });
  const target = panel.querySelector('.overlayPanel');
  // Keep the local controls in the DOM for the existing game's internal lookups.
  const legacy = document.createElement('div');
  legacy.hidden = true;
  legacy.append(...target.childNodes);
  target.append(legacy, body);
  return {
    close: body.querySelector('#onlineAdminClose'),
    async refresh(role) {
      body.querySelectorAll('[data-owner]').forEach((form) => {
        form.style.display = role === 'owner' ? '' : 'none';
      });
      status.textContent = '';
      try {
        await refresh();
      } catch (error) {
        status.textContent = error.message;
      }
    },
  };
};
