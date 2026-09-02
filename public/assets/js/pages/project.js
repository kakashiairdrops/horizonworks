import { api, requireSession } from '../api.js';
import { mountShell } from '../shell.js';
import {
  $, $$, el, esc, money, money2, initials, statusTag, formatTime, timeAgo,
  toast, withBusy, confirmDialog, param, formValues, applyFieldErrors
} from '../ui.js';

const FEE_RATE = 0.03;

// Declared before the top-level `await load()` below: a const used during that
// first render must already be initialised, or it is still in its dead zone.
const OUTCOME_LABEL = {
  release: 'Released in full to the specialist',
  refund: 'Refunded in full to the client',
  split: 'Split between both parties'
};

const projectId = param('id');
const session = await requireSession();
let state = null;

if (session) {
  await mountShell({
    crumb: `Horizon / Projects / Room`,
    actions: [el('a', { class: 'btn sm ghost', href: '/app/projects.html' }, ['← All projects'])]
  });
  if (!projectId) {
    $('#page').innerHTML = '<div class="empty"><strong>No project selected</strong>Open a project from your projects list.</div>';
  } else {
    await load();
  }
}

async function load(activeTab = 'overview') {
  const host = $('#page');
  if (!state) host.innerHTML = '<div class="skeleton" style="min-height:220px"></div>';
  try {
    state = await api.get(`/api/projects/${encodeURIComponent(projectId)}`);
    render(activeTab);
  } catch (error) {
    host.innerHTML = `<div class="empty"><strong>Project unavailable</strong>${esc(error.message)}</div>`;
  }
}

function render(activeTab) {
  const host = $('#page');
  const { project, messages, payments } = state;
  const isClient = project.client.id === session.user.id;
  const isTalent = project.talent.id === session.user.id;
  const counterparty = isTalent ? project.client : project.talent;
  document.title = `Horizon — ${project.name}`;

  host.innerHTML = '';
  host.append(el('div', { class: 'project-head' }, [
    el('div', {}, [
      el('h1', { text: project.name }),
      el('p', { style: 'margin:0;color:var(--muted);font-size:13.5px' }, [
        `${project.client.company || project.client.name} · ${project.talent.name} · `,
        el('span', { html: statusTag(project.status) })
      ])
    ]),
    el('div', { class: 'project-people' }, [
      el('div', { class: 'avatar sm', style: `--hue:${project.client.avatarHue}`, title: project.client.name, text: initials(project.client.name) }),
      el('div', { class: 'avatar sm', style: `--hue:${project.talent.avatarHue}`, title: project.talent.name, text: initials(project.talent.name) }),
      el('span', { style: 'font-size:12px;color:var(--muted)', text: `with ${counterparty.name}` })
    ])
  ]));

  const tiles = el('div', { class: 'stat-grid', style: 'margin-bottom:22px' }, [
    el('article', { class: 'stat' }, [
      el('small', { text: 'Project value' }),
      el('strong', { text: money(project.totals.total, project.asset) }),
      el('span', { text: `${project.milestones.length} milestones` })
    ]),
    el('article', { class: 'stat wallet-tile' }, [
      el('small', { text: 'Paid so far' }),
      el('strong', { text: money(project.totals.paid, project.asset) }),
      el('span', { text: `${project.totals.progress}% of the project` })
    ]),
    el('article', { class: 'stat' }, [
      el('small', { text: 'Currently in escrow' }),
      el('strong', { text: money(project.totals.escrow, project.asset) }),
      el('span', {
        text: project.totals.disputed
          ? `${money(project.totals.disputed, project.asset)} under dispute`
          : `${project.asset} on ${project.network}`
      })
    ]),
    el('article', { class: 'stat' }, [
      el('small', { text: 'Messages' }),
      el('strong', { text: String(messages.length).padStart(2, '0') }),
      el('span', { text: messages.length ? `Last ${timeAgo(messages[messages.length - 1].created_at)}` : 'No messages yet' })
    ])
  ]);
  host.append(tiles);

  const tabs = el('div', { class: 'tabs', role: 'tablist' });
  const panel = el('div', { id: 'tab-panel' });
  for (const [key, label] of [['overview', 'Milestones'], ['messages', `Messages (${messages.length})`], ['payments', `Payments (${payments.length})`]]) {
    tabs.append(el('button', {
      class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(key === activeTab),
      onclick: (event) => {
        $$('.tab').forEach((tab) => tab.setAttribute('aria-selected', 'false'));
        event.currentTarget.setAttribute('aria-selected', 'true');
        renderTab(key, panel, { isClient, isTalent });
      }
    }, [label]));
  }
  host.append(tabs, panel);
  renderTab(activeTab, panel, { isClient, isTalent });
}

function renderTab(tab, panel, roles) {
  panel.innerHTML = '';
  if (tab === 'messages') return panel.append(messagesView());
  if (tab === 'payments') return panel.append(paymentsView());
  return panel.append(milestonesView(roles));
}

function milestonesView({ isClient, isTalent }) {
  const { project } = state;
  const columns = el('div', { class: 'two-col' });

  const main = el('section', { class: 'card' }, [
    el('div', { class: 'card-head' }, [
      el('h2', { text: 'Milestones' }),
      isClient ? el('button', { class: 'btn sm ghost', type: 'button', onclick: () => openMilestoneForm() }, ['+ Add milestone']) : null
    ])
  ]);
  const list = el('div', { class: 'list' });

  for (const milestone of project.milestones) {
    const actions = el('div', { class: 'actions' });

    if (isClient && milestone.status === 'planned') {
      actions.append(el('button', {
        class: 'btn sm primary', type: 'button',
        onclick: (event) => act(event.currentTarget, `/api/milestones/${milestone.id}/fund`, {
          confirm: {
            title: 'Fund this milestone?',
            body: `${money2(milestone.amount, project.asset)} plus a ${money2(milestone.amount * FEE_RATE)} platform fee moves from your available balance into escrow. Simulated — no wallet is used.`,
            confirmLabel: 'Move to escrow'
          },
          success: 'Milestone funded and held in escrow.'
        })
      }, [`Fund ${money(milestone.amount, project.asset)} →`]));
      actions.append(el('button', { class: 'btn sm ghost', type: 'button', onclick: () => openMilestoneForm(milestone) }, ['Edit']));
      actions.append(el('button', {
        class: 'btn sm danger', type: 'button',
        onclick: (event) => act(event.currentTarget, `/api/milestones/${milestone.id}`, {
          method: 'delete',
          confirm: { title: 'Remove this milestone?', body: milestone.title, confirmLabel: 'Remove', variant: 'danger' },
          success: 'Milestone removed.'
        })
      }, ['Remove']));
    }

    if (isTalent && milestone.status === 'funded') {
      actions.append(el('button', {
        class: 'btn sm primary', type: 'button',
        onclick: (event) => act(event.currentTarget, `/api/milestones/${milestone.id}/submit`, {
          confirm: { title: 'Submit this work for review?', body: 'The client will be notified and can release the escrowed payment.', confirmLabel: 'Submit for review' },
          success: 'Submitted for review.'
        })
      }, ['Submit for review →']));
    }

    if (isClient && ['funded', 'submitted'].includes(milestone.status)) {
      actions.append(el('button', {
        class: 'btn sm primary', type: 'button',
        onclick: (event) => act(event.currentTarget, `/api/milestones/${milestone.id}/release`, {
          confirm: {
            title: 'Release the payment?',
            body: `${money2(milestone.amount, project.asset)} will settle to ${project.talent.name} on ${project.network}. This cannot be undone.`,
            confirmLabel: 'Release payment'
          },
          success: 'Payment released.'
        })
      }, [`Release ${money(milestone.amount, project.asset)} →`]));
      actions.append(el('button', {
        class: 'btn sm danger', type: 'button',
        onclick: (event) => act(event.currentTarget, `/api/milestones/${milestone.id}/refund`, {
          confirm: {
            title: 'Refund the escrow?',
            body: 'The full amount plus fee returns to your balance and the milestone resets to planned.',
            confirmLabel: 'Refund escrow', variant: 'danger'
          },
          success: 'Escrow refunded.'
        })
      }, ['Refund']));
    }

    // Either party can freeze a submitted milestone for admin arbitration.
    if (milestone.status === 'submitted' && (isClient || isTalent)) {
      actions.append(el('button', {
        class: 'btn sm ghost', type: 'button',
        onclick: () => openDisputeForm(milestone, { isClient })
      }, ['Raise a dispute']));
    }

    if (milestone.status === 'disputed') {
      const dispute = disputeFor(milestone.id);
      actions.append(el('span', {
        class: 'frozen-note',
        text: dispute && dispute.status === 'answered'
          ? 'Under review — both sides submitted. An operator will decide.'
          : 'Under review. Escrow is frozen until an operator decides.'
      }));
      if (dispute && dispute.raised_by === session.user.id) {
        actions.append(el('button', {
          class: 'btn sm ghost', type: 'button',
          onclick: (event) => act(event.currentTarget, `/api/disputes/${dispute.id}/withdraw`, {
            confirm: {
              title: 'Withdraw the dispute?',
              body: 'The milestone goes back to awaiting release.',
              confirmLabel: 'Withdraw'
            },
            success: 'Dispute withdrawn.'
          })
        }, ['Withdraw']));
      } else if (dispute && dispute.status === 'open') {
        actions.append(el('button', {
          class: 'btn sm primary', type: 'button',
          onclick: () => openResponseForm(dispute)
        }, ['Add your side']));
      }
    }

    if (isTalent && milestone.status === 'planned') {
      actions.append(el('span', { style: 'font-size:11.5px;color:var(--muted-dim)', text: 'Waiting for the client to fund this milestone.' }));
    }

    list.append(el('article', { class: `milestone is-${milestone.status}` }, [
      el('i', { class: 'num', text: milestone.status === 'paid' ? '✓' : String(milestone.position).padStart(2, '0') }),
      el('div', { class: 'grow' }, [
        el('h3', { text: milestone.title }),
        el('p', { text: milestone.description || 'No description.' }),
        el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:9px' }, [
          el('span', { html: statusTag(milestone.status) }),
          milestone.due_date ? el('span', { style: 'font:9.5px var(--mono);color:var(--muted-dim)', text: `DUE ${milestone.due_date}` }) : null
        ]),
        actions
      ]),
      el('strong', { class: 'amount', text: money(milestone.amount, project.asset) })
    ]));
  }

  main.append(list);
  columns.append(main);

  const side = el('aside', {}, [
    disputeCard(),
    el('section', { class: 'card' }, [
      el('div', { class: 'card-head' }, [el('h2', { text: 'How escrow works here' })]),
      el('ol', { style: 'margin:0;padding-left:18px;font-size:12.5px;color:var(--muted);line-height:1.9' }, [
        el('li', { text: 'The client funds a milestone — amount plus a 3% fee leaves their balance.' }),
        el('li', { text: 'The specialist delivers and submits it for review.' }),
        el('li', { text: 'The client releases; the amount settles to the specialist.' }),
        el('li', { text: 'Or refunds, returning everything and resetting the milestone.' }),
        el('li', { text: 'If the two disagree, either side disputes it and an operator decides.' })
      ]),
      el('p', { style: 'margin:14px 0 0;font:9px var(--mono);letter-spacing:.7px;text-transform:uppercase;color:var(--muted-dim);line-height:1.6', text: 'Simulated settlement. No wallet is connected and no transaction is broadcast.' })
    ]),
    reviewCard()
  ].filter(Boolean));
  columns.append(side);
  return columns;
}

/** The dispute record for a milestone, if one was ever raised. */
function disputeFor(milestoneId) {
  return (state.disputes || []).find((dispute) => dispute.milestone_id === milestoneId) || null;
}

/** Shows open and past disputes so both parties can see where things stand. */
function disputeCard() {
  const disputes = state.disputes || [];
  if (!disputes.length) return null;

  const list = el('div', { class: 'list' });
  for (const dispute of disputes) {
    const resolved = dispute.status === 'resolved';
    list.append(el('article', { style: 'padding:12px 0;border-bottom:1px solid var(--line)' }, [
      el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:7px' }, [
        el('span', { html: statusTag(dispute.status) }),
        el('strong', { style: 'font-size:13px', text: dispute.milestone_title })
      ]),
      el('p', {
        style: 'margin:0 0 6px;font-size:12.5px;color:var(--muted);line-height:1.65',
        text: `${dispute.raised_by_name} asked for a ${dispute.desired}: ${dispute.reason}`
      }),
      dispute.response
        ? el('p', {
          style: 'margin:0 0 6px;font-size:12.5px;color:var(--muted);line-height:1.65;padding-left:10px;border-left:2px solid var(--line)',
          text: `${dispute.responded_by_name || 'The other party'} replied: ${dispute.response}`
        })
        : null,
      resolved
        ? el('p', { style: 'margin:0;font-size:12.5px;color:var(--fg)' }, [
          el('strong', { text: `${OUTCOME_LABEL[dispute.outcome] || dispute.outcome}. ` }),
          dispute.resolution
        ])
        : el('span', { style: 'font:9px var(--mono);letter-spacing:.7px;text-transform:uppercase;color:var(--muted-dim)', text: `Raised ${timeAgo(dispute.created_at)}` })
    ].filter(Boolean)));
  }

  return el('section', { class: 'card' }, [
    el('div', { class: 'card-head' }, [el('h2', { text: 'Disputes' })]),
    list
  ]);
}

function reviewCard() {
  const { project, myReview } = state;
  const hasPaid = project.milestones.some((milestone) => milestone.status === 'paid');
  if (!hasPaid) return null;
  if (myReview) {
    return el('section', { class: 'card', style: 'margin-top:14px' }, [
      el('div', { class: 'card-head' }, [el('h2', { text: 'Your review' })]),
      el('div', { class: 'stars', style: 'color:var(--lime);letter-spacing:2px', text: '★'.repeat(myReview.rating) + '☆'.repeat(5 - myReview.rating) }),
      el('p', { style: 'margin:8px 0 0;font-size:13px;color:var(--muted)', text: myReview.comment || 'No comment left.' })
    ]);
  }
  return el('section', { class: 'card', style: 'margin-top:14px' }, [
    el('div', { class: 'card-head' }, [el('h2', { text: 'Leave a review' })]),
    el('p', { style: 'margin:0 0 12px;font-size:12.5px;color:var(--muted)', text: 'A milestone has been paid, so you can review this collaboration.' }),
    el('button', { class: 'btn primary block', type: 'button', onclick: openReviewForm }, ['Write a review'])
  ]);
}

function messagesView() {
  const { messages, project } = state;
  const wrapper = el('section', { class: 'card' }, [el('div', { class: 'card-head' }, [el('h2', { text: 'Project messages' })])]);
  const thread = el('div', { class: 'thread' });

  if (!messages.length) {
    thread.append(el('div', { class: 'empty', text: 'No messages yet. Say hello and confirm the plan.' }));
  }
  for (const message of messages) {
    const mine = message.author_id === session.user.id;
    thread.append(el('div', { class: `bubble${mine ? ' mine' : ''}` }, [
      el('div', { class: 'avatar sm', style: `--hue:${message.author_hue}`, text: initials(message.author_name) }),
      el('div', { class: 'body' }, [
        el('div', { class: 'who' }, [
          el('strong', { text: mine ? 'You' : message.author_name }),
          el('time', { datetime: message.created_at, text: formatTime(message.created_at) })
        ]),
        el('p', { text: message.body }),
        // Attachments are links to work hosted elsewhere; nothing is uploaded here.
        message.attachment
          ? el('a', {
            class: 'attachment', href: message.attachment,
            target: '_blank', rel: 'noopener noreferrer',
            title: message.attachment,
            text: `▧ ${attachmentLabel(message.attachment)}`
          })
          : null
      ])
    ]));
  }
  wrapper.append(thread);

  // novalidate, like every other form here: the server owns validation so the
  // error message is consistent whether it came from the browser or the API.
  const form = el('form', { class: 'composer', novalidate: true }, [
    el('textarea', { name: 'body', required: true, maxlength: 4000, placeholder: `Message ${project.client.id === session.user.id ? project.talent.name : project.client.name}…`, 'aria-label': 'Message' }),
    el('div', { class: 'composer-side' }, [
      el('input', {
        name: 'attachment', type: 'url', maxlength: 400, class: 'attachment-input',
        placeholder: 'Attach a link (optional)', 'aria-label': 'Attachment link'
      }),
      el('button', { class: 'btn primary', type: 'submit' }, ['Send →'])
    ])
  ]);
  const composerError = el('div', { class: 'alert error', hidden: true });
  form.prepend(composerError);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = form.elements.body.value.trim();
    if (!body) return;
    const attachment = form.elements.attachment.value.trim();
    const submit = form.querySelector('button[type="submit"]');
    composerError.hidden = true;
    try {
      const payload = attachment ? { body, attachment } : { body };
      await withBusy(submit, () => api.post(`/api/projects/${encodeURIComponent(projectId)}/messages`, payload));
      form.elements.body.value = '';
      form.elements.attachment.value = '';
      await load('messages');
      const threadNode = $('.thread');
      if (threadNode) threadNode.scrollTop = threadNode.scrollHeight;
    } catch (error) {
      composerError.textContent = error.details?.attachment || error.message;
      composerError.hidden = false;
      toast(error.message, { variant: 'error' });
    }
  });
  wrapper.append(form);

  setTimeout(() => { thread.scrollTop = thread.scrollHeight; }, 0);
  return wrapper;
}

/** Shows a readable filename or host instead of a long URL. */
function attachmentLabel(url) {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop();
    return last ? `${parsed.host}/${decodeURIComponent(last)}` : parsed.host;
  } catch {
    return url;
  }
}

function paymentsView() {
  const { payments, project } = state;
  const wrapper = el('section', { class: 'card' }, [el('div', { class: 'card-head' }, [el('h2', { text: 'Payment history' })])]);
  if (!payments.length) {
    wrapper.append(el('div', { class: 'empty', text: 'No escrow activity yet. Fund a milestone to get started.' }));
    return wrapper;
  }
  const table = el('table', { class: 'ledger' });
  table.innerHTML = `
    <thead><tr><th>Milestone</th><th>Status</th><th>Reference</th><th class="num">Fee</th><th class="num">Amount</th></tr></thead>
    <tbody>${payments.map((payment) => `
      <tr>
        <td><strong>${esc(payment.milestone_title || 'Direct payment')}</strong><br>
          <span style="font-size:11px;color:var(--muted-dim)">${esc(formatTime(payment.created_at))}</span></td>
        <td>${statusTag(payment.status)}</td>
        <td><code>${esc(payment.tx_ref || '—')}</code></td>
        <td class="num" style="color:var(--muted)">${money2(payment.fee, '')}</td>
        <td class="num">${money2(payment.amount, payment.asset)}</td>
      </tr>`).join('')}</tbody>`;
  wrapper.append(el('div', { class: 'table-scroll' }, [table]));
  wrapper.append(el('p', {
    style: 'margin:14px 0 0;font:9px var(--mono);letter-spacing:.7px;text-transform:uppercase;color:var(--muted-dim)',
    text: `All amounts in ${project.asset} on ${project.network}. Simulated settlement.`
  }));
  return wrapper;
}

/** Runs a milestone action with an optional confirmation, then reloads. */
async function act(button, path, { method = 'post', confirm, success }) {
  if (confirm) {
    const ok = await confirmDialog(confirm);
    if (!ok) return;
  }
  try {
    await withBusy(button, () => (method === 'delete' ? api.delete(path) : api.post(path, {})));
    toast(success, { variant: 'ok' });
    await load('overview');
  } catch (error) {
    toast(error.message, { variant: 'error', title: 'Action failed' });
  }
}

function openMilestoneForm(milestone = null) {
  const editing = Boolean(milestone);
  const dialog = el('dialog', { class: 'modal' });
  dialog.innerHTML = `
    <form id="milestone-form" novalidate>
      <div class="modal-head"><h2>${editing ? 'Edit milestone' : 'Add milestone'}</h2>
        <button class="close-x" type="button" aria-label="Close">×</button></div>
      <div class="modal-body">
        <div class="alert error" id="milestone-error" hidden></div>
        <label class="field"><span>Title</span><input name="title" required minlength="3" maxlength="120" placeholder="Design system & build"></label>
        <label class="field"><span>What does done look like?</span><textarea name="description" rows="3" maxlength="1000"></textarea></label>
        <div class="grid-2">
          <label class="field"><span>Amount (${esc(state.project.asset)})</span><input name="amount" required inputmode="decimal" placeholder="1700"></label>
          <label class="field"><span>Due date (optional)</span><input name="due_date" type="date"></label>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn ghost" type="button" data-act="cancel">Cancel</button>
        <button class="btn primary" type="submit">${editing ? 'Save milestone' : 'Add milestone'}</button>
      </div>
    </form>`;
  document.body.append(dialog);
  const form = $('#milestone-form', dialog);
  if (editing) {
    form.elements.title.value = milestone.title;
    form.elements.description.value = milestone.description;
    form.elements.amount.value = milestone.amount;
    if (milestone.due_date) form.elements.due_date.value = milestone.due_date;
  }
  const close = () => { dialog.close(); dialog.remove(); };
  $('.close-x', dialog).onclick = close;
  $('[data-act="cancel"]', dialog).onclick = close;
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  dialog.showModal();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = form.querySelector('button[type="submit"]');
    try {
      const values = formValues(form);
      if (!values.due_date) delete values.due_date;
      await withBusy(submit, () => (editing
        ? api.patch(`/api/milestones/${encodeURIComponent(milestone.id)}`, values)
        : api.post(`/api/projects/${encodeURIComponent(projectId)}/milestones`, values)));
      close();
      toast(editing ? 'Milestone updated.' : 'Milestone added.');
      await load('overview');
    } catch (error) {
      applyFieldErrors(form, error.details);
      const box = $('#milestone-error', dialog);
      box.textContent = error.message;
      box.hidden = false;
    }
  });
}

/** Either party freezes a submitted milestone and states what they want. */
function openDisputeForm(milestone, { isClient }) {
  const dialog = el('dialog', { class: 'modal' });
  dialog.innerHTML = `
    <form id="dispute-form" novalidate>
      <div class="modal-head"><h2>Raise a dispute</h2>
        <button class="close-x" type="button" aria-label="Close">×</button></div>
      <div class="modal-body">
        <div class="alert error" id="dispute-error" hidden></div>
        <p style="margin:0 0 14px;font-size:12.5px;color:var(--muted);line-height:1.65">
          ${esc(milestone.title)} — ${esc(money2(milestone.amount, state.project.asset))} stays frozen in escrow
          until an operator decides. Neither side can release or refund it in the meantime.
        </p>
        <label class="field"><span>What went wrong?</span>
          <textarea name="reason" required minlength="20" maxlength="2000" rows="5"
            placeholder="Be specific about what was delivered, what was expected, and what you have already tried."></textarea>
          <span class="field-hint">At least 20 characters. The other party sees this.</span>
        </label>
        <label class="field"><span>What outcome are you asking for?</span>
          <select name="desired">
            <option value="${isClient ? 'refund' : 'release'}">${isClient ? 'Refund the escrow to me' : 'Release the payment to me'}</option>
            <option value="split">Split it — partial payment</option>
            <option value="${isClient ? 'release' : 'refund'}">${isClient ? 'Release anyway' : 'Refund the client'}</option>
          </select>
        </label>
      </div>
      <div class="modal-foot">
        <button class="btn ghost" type="button" data-act="cancel">Cancel</button>
        <button class="btn danger" type="submit">Freeze & request review</button>
      </div>
    </form>`;
  document.body.append(dialog);
  const form = $('#dispute-form', dialog);
  const close = () => { dialog.close(); dialog.remove(); };
  $('.close-x', dialog).onclick = close;
  $('[data-act="cancel"]', dialog).onclick = close;
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  dialog.showModal();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = form.querySelector('button[type="submit"]');
    try {
      await withBusy(submit, () => api.post(`/api/milestones/${encodeURIComponent(milestone.id)}/dispute`, formValues(form)));
      close();
      toast('Dispute raised. An operator will review it.', { variant: 'ok' });
      await load('overview');
    } catch (error) {
      applyFieldErrors(form, error.details);
      const box = $('#dispute-error', dialog);
      box.textContent = error.message;
      box.hidden = false;
    }
  });
}

/** The counterparty answers an open dispute before an admin decides. */
function openResponseForm(dispute) {
  const dialog = el('dialog', { class: 'modal' });
  dialog.innerHTML = `
    <form id="response-form" novalidate>
      <div class="modal-head"><h2>Add your side</h2>
        <button class="close-x" type="button" aria-label="Close">×</button></div>
      <div class="modal-body">
        <div class="alert error" id="response-error" hidden></div>
        <p style="margin:0 0 14px;font-size:12.5px;color:var(--muted);line-height:1.65">
          ${esc(dispute.raised_by_name)} wrote: ${esc(dispute.reason)}
        </p>
        <label class="field"><span>Your response</span>
          <textarea name="response" required minlength="20" maxlength="2000" rows="5"
            placeholder="Explain what you delivered and why you believe the milestone is complete."></textarea>
          <span class="field-hint">At least 20 characters. The operator reads both accounts.</span>
        </label>
      </div>
      <div class="modal-foot">
        <button class="btn ghost" type="button" data-act="cancel">Cancel</button>
        <button class="btn primary" type="submit">Submit response</button>
      </div>
    </form>`;
  document.body.append(dialog);
  const form = $('#response-form', dialog);
  const close = () => { dialog.close(); dialog.remove(); };
  $('.close-x', dialog).onclick = close;
  $('[data-act="cancel"]', dialog).onclick = close;
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  dialog.showModal();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = form.querySelector('button[type="submit"]');
    try {
      await withBusy(submit, () => api.post(`/api/disputes/${encodeURIComponent(dispute.id)}/respond`, formValues(form)));
      close();
      toast('Response recorded.', { variant: 'ok' });
      await load('overview');
    } catch (error) {
      applyFieldErrors(form, error.details);
      const box = $('#response-error', dialog);
      box.textContent = error.message;
      box.hidden = false;
    }
  });
}

function openReviewForm() {
  const dialog = el('dialog', { class: 'modal' });
  dialog.innerHTML = `
    <form id="review-form">
      <div class="modal-head"><h2>Review this collaboration</h2>
        <button class="close-x" type="button" aria-label="Close">×</button></div>
      <div class="modal-body">
        <div class="alert error" id="review-error" hidden></div>
        <label class="field"><span>Rating</span>
          <select name="rating" required>
            <option value="5">★★★★★ — Exceptional</option>
            <option value="4">★★★★ — Very good</option>
            <option value="3">★★★ — Solid</option>
            <option value="2">★★ — Below expectations</option>
            <option value="1">★ — Poor</option>
          </select>
        </label>
        <label class="field"><span>Comment (optional)</span>
          <textarea name="comment" rows="4" maxlength="1000" placeholder="What went well, and what could have gone better?"></textarea>
        </label>
      </div>
      <div class="modal-foot">
        <button class="btn ghost" type="button" data-act="cancel">Cancel</button>
        <button class="btn primary" type="submit">Publish review</button>
      </div>
    </form>`;
  document.body.append(dialog);
  const close = () => { dialog.close(); dialog.remove(); };
  $('.close-x', dialog).onclick = close;
  $('[data-act="cancel"]', dialog).onclick = close;
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  dialog.showModal();

  $('#review-form', dialog).addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('button[type="submit"]');
    try {
      await withBusy(submit, () => api.post(`/api/projects/${encodeURIComponent(projectId)}/reviews`, formValues(form)));
      close();
      toast('Review published.');
      await load('overview');
    } catch (error) {
      const box = $('#review-error', dialog);
      box.textContent = error.message;
      box.hidden = false;
    }
  });
}
