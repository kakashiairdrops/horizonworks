import { api, requireSession } from '../api.js';
import { mountShell } from '../shell.js';
import {
  $, el, esc, money, money2, compactMoney, initials, statusTag,
  timeAgo, formatTime, toast, withBusy, confirmDialog, AVAILABILITY_LABEL
} from '../ui.js';

const session = await requireSession(['admin']);

if (session) {
  await mountShell({
    title: 'The network, in motion.',
    crumb: 'Horizon / Admin / Control room'
  });
  load();
}

async function load() {
  const host = $('#page');
  host.innerHTML = '<div class="skeleton" style="min-height:200px"></div>';
  try {
    const data = await api.get('/api/admin/overview');
    host.innerHTML = '';
    host.append(el('p', { class: 'subtitle', text: 'Review new profiles, keep briefs moving, and watch the escrow ledger.' }));

    const tiles = el('div', { class: 'stat-grid', style: 'margin-bottom:26px' }, [
      tile('Accounts', String(data.counts.users).padStart(2, '0'), `${data.counts.talent} specialist profiles`),
      tile('Profiles to review', String(data.counts.pendingTalent).padStart(2, '0'), 'Awaiting approval', data.counts.pendingTalent > 0),
      tile('Open disputes', String(data.counts.openDisputes || 0).padStart(2, '0'), 'Escrow frozen pending a decision', (data.counts.openDisputes || 0) > 0),
      tile('Open briefs', String(data.counts.openBriefs).padStart(2, '0'), `${data.counts.activeProjects} active projects`),
      tile('New inquiries', String(data.counts.newInquiries).padStart(2, '0'), 'From the public site'),
      tile('Held in escrow', compactMoney(data.money.escrow), 'Across all projects', true),
      tile('Released to talent', compactMoney(data.money.released), `${compactMoney(data.money.fees)} in platform fees`)
    ]);
    host.append(tiles);

    const grid = el('div', { class: 'admin-grid' });
    const left = el('div', {});
    const right = el('div', {});

    // Dispute arbitration ----------------------------------------------------
    left.append(disputesSection(data.disputes || []));

    // Profile approval queue -------------------------------------------------
    const queue = el('section', { class: 'card', style: 'margin-top:14px' }, [
      el('div', { class: 'card-head' }, [
        el('h2', { text: `Profiles awaiting review (${data.pendingTalent.length})` }),
        el('a', { href: '/app/talent.html', style: 'font:10px var(--mono);letter-spacing:1px;text-transform:uppercase;color:var(--lime);text-decoration:none' }, ['Directory ↗'])
      ])
    ]);
    if (!data.pendingTalent.length) {
      queue.append(el('div', { class: 'empty', text: 'Nothing in the review queue. New specialist profiles land here.' }));
    }
    for (const person of data.pendingTalent) {
      queue.append(el('article', { class: 'review-row', style: 'margin-bottom:9px' }, [
        el('div', { class: 'avatar', text: initials(person.name) }),
        el('div', { class: 'grow' }, [
          el('h3', { text: person.name }),
          el('p', { text: `${person.headline || 'No headline yet'} · ${person.location || 'No location'}` }),
          el('p', { style: 'margin-top:3px', text: `$${person.rate_min}–${person.rate_max}/hr · ${AVAILABILITY_LABEL[person.availability]} · ${person.payout_asset} on ${person.payout_network}` })
        ]),
        el('div', { class: 'actions' }, [
          el('a', { class: 'btn sm ghost', href: `/talent-profile.html?id=${encodeURIComponent(person.user_id)}`, target: '_blank', rel: 'noopener' }, ['Preview ↗']),
          el('button', {
            class: 'btn sm primary', type: 'button',
            onclick: (event) => decide(event.currentTarget, person, 'approved')
          }, ['Approve']),
          el('button', {
            class: 'btn sm danger', type: 'button',
            onclick: (event) => decide(event.currentTarget, person, 'rejected')
          }, ['Request changes'])
        ])
      ]));
    }
    left.append(queue);

    // Escrow queue ----------------------------------------------------------
    const escrow = el('section', { class: 'card', style: 'margin-top:14px' }, [
      el('div', { class: 'card-head' }, [el('h2', { text: `Escrow currently held (${data.escrowQueue.length})` })])
    ]);
    if (!data.escrowQueue.length) {
      escrow.append(el('div', { class: 'empty', text: 'No funds are held in escrow right now.' }));
    } else {
      const table = el('table', { class: 'ledger' });
      table.innerHTML = `
        <thead><tr><th>Project</th><th>Parties</th><th>Milestone</th><th class="num">Amount</th></tr></thead>
        <tbody>${data.escrowQueue.map((payment) => `
          <tr>
            <td><strong>${esc(payment.project_name)}</strong><br>
              <span style="font-size:11px;color:var(--muted-dim)">${esc(formatTime(payment.created_at))}</span></td>
            <td style="font-size:12px">${esc(payment.payer_name)} → ${esc(payment.payee_name)}</td>
            <td>${esc(payment.milestone_title || '—')}<br>${statusTag(payment.milestone_status || 'funded')}</td>
            <td class="num">${money2(payment.amount, payment.asset)}<br>
              <span style="font-size:11px;color:var(--muted-dim)">+${money2(payment.fee)} fee</span></td>
          </tr>`).join('')}</tbody>`;
      escrow.append(el('div', { class: 'table-scroll' }, [table]));
    }
    left.append(escrow);

    // Briefs ----------------------------------------------------------------
    const briefs = el('section', { class: 'card', style: 'margin-top:14px' }, [
      el('div', { class: 'card-head' }, [el('h2', { text: `Recent briefs (${data.briefs.length})` })])
    ]);
    if (!data.briefs.length) {
      briefs.append(el('div', { class: 'empty', text: 'No briefs posted yet.' }));
    }
    for (const brief of data.briefs) {
      briefs.append(el('div', { class: 'review-row', style: 'margin-bottom:8px' }, [
        el('div', { class: 'grow' }, [
          el('h3', { text: brief.title }),
          el('p', { text: `${brief.client_company || brief.client_name} · ${brief.category} · ${money(brief.budget_min)}–${money(brief.budget_max)} · ${brief.invitations} invitation${brief.invitations === 1 ? '' : 's'}` })
        ]),
        el('span', { html: statusTag(brief.status) })
      ]));
    }
    left.append(briefs);

    // Inquiries -------------------------------------------------------------
    const inquiries = el('section', { class: 'card' }, [
      el('div', { class: 'card-head' }, [el('h2', { text: `Inbound inquiries (${data.inquiries.length})` })])
    ]);
    if (!data.inquiries.length) {
      inquiries.append(el('div', { class: 'empty', text: 'No inquiries from the public site yet.' }));
    }
    for (const inquiry of data.inquiries) {
      const select = el('select', {
        style: 'width:auto;padding:6px 9px;font-size:11.5px',
        onchange: async (event) => {
          try {
            await api.patch(`/api/admin/inquiries/${encodeURIComponent(inquiry.id)}`, { status: event.target.value });
            toast('Inquiry updated.');
          } catch (error) {
            toast(error.message, { variant: 'error' });
          }
        }
      });
      for (const [value, label] of [['new', 'New'], ['contacted', 'Contacted'], ['closed', 'Closed']]) {
        select.append(el('option', { value, selected: inquiry.status === value }, [label]));
      }
      inquiries.append(el('div', { style: 'padding:11px 0;border-bottom:1px solid var(--line)' }, [
        el('div', { style: 'display:flex;justify-content:space-between;gap:10px;align-items:flex-start' }, [
          el('div', {}, [
            el('strong', { style: 'font-size:13.5px', text: inquiry.name }),
            el('p', { style: 'margin:3px 0 0;font-size:12px;color:var(--muted)', text: `${inquiry.email} · ${inquiry.role} · ${inquiry.service || 'general'}` }),
            inquiry.note ? el('p', { style: 'margin:6px 0 0;font-size:12px;color:var(--muted-dim);line-height:1.6', text: inquiry.note }) : null
          ]),
          select
        ]),
        el('span', { style: 'font:9.5px var(--mono);color:var(--muted-dim);text-transform:uppercase', text: timeAgo(inquiry.created_at) })
      ]));
    }
    right.append(inquiries);

    // Audit -----------------------------------------------------------------
    const audit = el('section', { class: 'card', style: 'margin-top:14px' }, [
      el('div', { class: 'card-head' }, [el('h2', { text: 'Audit trail' })])
    ]);
    const auditList = el('div', { class: 'audit-list' });
    if (!data.audit.length) auditList.append(el('div', { class: 'empty', text: 'No recorded actions yet.' }));
    for (const entry of data.audit) {
      auditList.append(el('div', { class: 'audit-item' }, [
        el('div', {}, [
          el('code', { text: entry.action }),
          el('span', { style: 'display:block;color:var(--muted);font-family:var(--font);font-size:12px;text-transform:none;letter-spacing:0', text: `${entry.actor_name || 'system'} · ${entry.entity}` })
        ]),
        el('span', { text: timeAgo(entry.created_at) })
      ]));
    }
    audit.append(auditList);
    right.append(audit);

    grid.append(left, right);
    host.append(grid);
  } catch (error) {
    host.innerHTML = `<div class="alert error">${esc(error.message)}</div>`;
  }
}

function tile(label, value, hint, highlight = false) {
  return el('article', { class: `stat${highlight ? ' wallet-tile' : ''}` }, [
    el('small', { text: label }),
    el('strong', { text: value }),
    el('span', { text: hint })
  ]);
}

const OUTCOME_LABEL = {
  release: 'Released in full to the specialist',
  refund: 'Refunded in full to the client',
  split: 'Split between both parties'
};

/** The arbitration queue: open disputes first, then the decided ones. */
function disputesSection(disputes) {
  const openOnes = disputes.filter((dispute) => ['open', 'answered'].includes(dispute.status));
  const section = el('section', { class: 'card' }, [
    el('div', { class: 'card-head' }, [
      el('h2', { text: `Disputes to arbitrate (${openOnes.length})` })
    ])
  ]);

  if (!disputes.length) {
    section.append(el('div', { class: 'empty', text: 'No disputes. When a client and specialist disagree about a submitted milestone, it lands here.' }));
    return section;
  }

  for (const dispute of disputes) {
    const resolved = dispute.status === 'resolved' || dispute.status === 'withdrawn';
    const rows = [
      el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:7px' }, [
        el('span', { html: statusTag(dispute.status) }),
        el('strong', { style: 'font-size:13.5px', text: dispute.project_name }),
        el('span', { style: 'font-size:12px;color:var(--muted)', text: `${dispute.milestone_title} · ${money2(dispute.amount, dispute.asset)}` })
      ]),
      el('p', {
        style: 'margin:0 0 6px;font-size:12.5px;color:var(--muted);line-height:1.65',
        text: `${dispute.raised_by_name} (${dispute.raised_by_role}) asked for a ${dispute.desired}: ${dispute.reason}`
      }),
      dispute.response
        ? el('p', {
          style: 'margin:0 0 6px;font-size:12.5px;color:var(--muted);line-height:1.65;padding-left:10px;border-left:2px solid var(--line)',
          text: `${dispute.responded_by_name || 'The other party'} replied: ${dispute.response}`
        })
        : el('p', { style: 'margin:0 0 6px;font:9.5px var(--mono);text-transform:uppercase;letter-spacing:.7px;color:var(--muted-dim)', text: 'No response from the other party yet' })
    ];

    if (resolved) {
      rows.push(el('p', { style: 'margin:0;font-size:12.5px;color:var(--fg)' }, [
        el('strong', { text: dispute.status === 'withdrawn' ? 'Withdrawn by the party who raised it. ' : `${OUTCOME_LABEL[dispute.outcome] || dispute.outcome}. ` }),
        dispute.resolution || ''
      ]));
    } else {
      rows.push(el('div', { class: 'actions' }, [
        el('button', {
          class: 'btn sm primary', type: 'button',
          onclick: () => openResolveForm(dispute, 'release')
        }, ['Release to specialist']),
        el('button', {
          class: 'btn sm ghost', type: 'button',
          onclick: () => openResolveForm(dispute, 'split')
        }, ['Split']),
        el('button', {
          class: 'btn sm danger', type: 'button',
          onclick: () => openResolveForm(dispute, 'refund')
        }, ['Refund client'])
      ]));
    }

    section.append(el('article', {
      class: 'review-row',
      style: 'display:block;margin-bottom:9px'
    }, rows.filter(Boolean)));
  }

  return section;
}

/**
 * Admin resolution. A split needs an explicit talent share; the other two
 * outcomes move the whole amount one way, so only a rationale is required.
 */
function openResolveForm(dispute, outcome) {
  const amount = Number(dispute.amount);
  const titles = {
    release: 'Release the full amount',
    refund: 'Refund the full amount',
    split: 'Split the escrow'
  };
  const dialog = el('dialog', { class: 'modal' });
  dialog.innerHTML = `
    <form id="resolve-form" novalidate>
      <div class="modal-head"><h2>${esc(titles[outcome])}</h2>
        <button class="close-x" type="button" aria-label="Close">×</button></div>
      <div class="modal-body">
        <div class="alert error" id="resolve-error" hidden></div>
        <p style="margin:0 0 14px;font-size:12.5px;color:var(--muted);line-height:1.65">
          ${esc(dispute.project_name)} — ${esc(dispute.milestone_title)},
          ${esc(money2(amount, dispute.asset))} held.
          ${outcome === 'release' ? `The full amount goes to ${esc(dispute.talent_name)}; the platform fee is retained.`
            : outcome === 'refund' ? `The amount and the fee both return to ${esc(dispute.client_name)}, and the milestone resets to planned.`
              : 'Award part of it to the specialist; the rest returns to the client. The platform fee is retained.'}
        </p>
        ${outcome === 'split' ? `
          <label class="field"><span>To ${esc(dispute.talent_name)} (${esc(dispute.asset)})</span>
            <input name="talent_share" required inputmode="decimal" placeholder="${(amount / 2).toFixed(2)}">
            <span class="field-hint">Between 0 and ${esc(String(amount))}, exclusive. The remainder returns to ${esc(dispute.client_name)}.</span>
          </label>` : ''}
        <label class="field"><span>Rationale</span>
          <textarea name="resolution" required minlength="10" maxlength="2000" rows="4"
            placeholder="Both parties see this. Explain what the evidence showed and why you decided this way."></textarea>
        </label>
      </div>
      <div class="modal-foot">
        <button class="btn ghost" type="button" data-act="cancel">Cancel</button>
        <button class="btn ${outcome === 'refund' ? 'danger' : 'primary'}" type="submit">Resolve & move funds</button>
      </div>
    </form>`;
  document.body.append(dialog);
  const form = $('#resolve-form', dialog);
  const close = () => { dialog.close(); dialog.remove(); };
  $('.close-x', dialog).onclick = close;
  $('[data-act="cancel"]', dialog).onclick = close;
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  dialog.showModal();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = form.querySelector('button[type="submit"]');
    const payload = { outcome, resolution: form.elements.resolution.value.trim() };
    if (outcome === 'split') payload.talent_share = form.elements.talent_share.value.trim();
    try {
      await withBusy(submit, () => api.post(`/api/admin/disputes/${encodeURIComponent(dispute.id)}/resolve`, payload));
      close();
      toast('Dispute resolved and funds moved.', { variant: 'ok' });
      load();
    } catch (error) {
      const box = $('#resolve-error', dialog);
      box.textContent = error.details?.talent_share || error.message;
      box.hidden = false;
    }
  });
}

async function decide(button, person, status) {
  const approving = status === 'approved';
  const ok = await confirmDialog(approving
    ? {
      title: `Approve ${person.name}?`,
      body: 'They will appear in the public directory and in client match results immediately.',
      confirmLabel: 'Approve profile'
    }
    : {
      title: `Request changes from ${person.name}?`,
      body: 'They are notified and can edit their profile, which returns it to this queue.',
      confirmLabel: 'Request changes', variant: 'danger'
    });
  if (!ok) return;

  try {
    await withBusy(button, () => api.post(`/api/admin/talent/${encodeURIComponent(person.user_id)}/status`, {
      status,
      verified: approving,
      note: approving ? 'Your profile has been approved and is now live.' : 'An operator asked for a few changes before your profile goes live.'
    }));
    toast(approving ? `${person.name} approved.` : 'Changes requested.');
    load();
  } catch (error) {
    toast(error.message, { variant: 'error' });
  }
}
