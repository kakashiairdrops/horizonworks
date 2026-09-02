import { api, requireSession } from '../api.js';
import { mountShell } from '../shell.js';
import { $, el, esc, money, money2, compactMoney, statusTag, formatTime } from '../ui.js';

const session = await requireSession();

if (session) {
  const isTalent = session.user.role === 'talent';
  await mountShell({
    title: isTalent ? 'Earnings' : session.user.role === 'admin' ? 'Escrow ledger' : 'Payments & escrow',
    crumb: `Horizon / ${session.user.company || session.user.name} / Payments`
  });
  load(isTalent);
}

async function load(isTalent) {
  const host = $('#page');
  host.innerHTML = '<div class="skeleton"></div>';
  try {
    const { payments, wallets, feeRate } = await api.get('/api/payments');
    host.innerHTML = '';

    host.append(el('p', {
      class: 'subtitle',
      text: isTalent
        ? 'Every milestone that has been escrowed for you, and everything already settled.'
        : `Escrow activity across your projects. A ${Math.round(feeRate * 100)}% platform fee is added when you fund a milestone.`
    }));

    const tiles = el('div', { class: 'stat-grid', style: 'margin-bottom:24px' });
    for (const wallet of wallets) {
      tiles.append(el('article', { class: 'stat wallet-tile' }, [
        el('small', { text: isTalent ? 'Available to withdraw' : 'Available to fund' }),
        el('strong', { text: money2(wallet.available, wallet.asset) }),
        el('span', { text: `${wallet.network} · ${money2(wallet.in_escrow)} in escrow` })
      ]));
    }

    // A split settled only part of its amount, so totals read settled_amount.
    const settled = payments.filter((payment) => payment.status === 'released' || payment.status === 'split');
    const escrowed = payments.filter((payment) => payment.status === 'escrow_funded');
    const splits = settled.filter((payment) => payment.status === 'split').length;
    tiles.append(
      el('article', { class: 'stat' }, [
        el('small', { text: isTalent ? 'Total earned' : 'Total released' }),
        el('strong', { text: compactMoney(settled.reduce((sum, payment) => sum + payment.settled_amount, 0)) }),
        el('span', {
          text: `${settled.length} settled payment${settled.length === 1 ? '' : 's'}`
            + (splits ? ` · ${splits} arbitrated` : '')
        })
      ]),
      el('article', { class: 'stat' }, [
        el('small', { text: 'Currently in escrow' }),
        el('strong', { text: compactMoney(escrowed.reduce((sum, payment) => sum + payment.amount, 0)) }),
        el('span', { text: `${escrowed.length} milestone${escrowed.length === 1 ? '' : 's'}` })
      ]),
      el('article', { class: 'stat' }, [
        el('small', { text: isTalent ? 'Platform fees (paid by client)' : 'Platform fees paid' }),
        el('strong', { text: compactMoney(settled.reduce((sum, payment) => sum + payment.fee, 0)) }),
        el('span', { text: `${Math.round(feeRate * 100)}% per funded milestone` })
      ])
    );
    host.append(tiles);

    host.append(el('div', { class: 'section-title' }, [el('h2', { text: 'Ledger' })]));

    if (!payments.length) {
      host.append(el('div', { class: 'empty' }, [
        el('strong', { text: 'No escrow activity yet' }),
        isTalent ? 'Once a client funds one of your milestones it appears here.' : 'Fund a milestone in a project room to get started.'
      ]));
      return;
    }

    const table = el('table', { class: 'ledger' });
    table.innerHTML = `
      <thead><tr>
        <th>Project & milestone</th><th>${isTalent ? 'From' : 'To'}</th><th>Status</th>
        <th>Reference</th><th class="num">Fee</th><th class="num">Amount</th>
      </tr></thead>
      <tbody>${payments.map((payment) => `
        <tr>
          <td><strong>${esc(payment.project_name)}</strong><br>
            <span style="font-size:11.5px;color:var(--muted)">${esc(payment.milestone_title || 'Direct payment')}</span></td>
          <td>${esc(isTalent ? payment.payer_name : payment.payee_name)}<br>
            <span style="font-size:11px;color:var(--muted-dim)">${esc(formatTime(payment.created_at))}</span></td>
          <td>${statusTag(payment.status)}</td>
          <td><code>${esc(payment.tx_ref || '—')}</code></td>
          <td class="num" style="color:var(--muted)">${money2(payment.fee, '')}</td>
          <td class="num">${money2(payment.amount, payment.asset)}${payment.status === 'split'
            ? `<br><span style="font-size:11px;color:var(--warn)">${money2(payment.settled_amount, '')} settled</span>`
            : ''}</td>
        </tr>`).join('')}</tbody>`;
    host.append(el('section', { class: 'card tight' }, [el('div', { class: 'table-scroll' }, [table])]));
    host.append(el('p', {
      style: 'margin:16px 0 0;font:9px var(--mono);letter-spacing:.7px;text-transform:uppercase;color:var(--muted-dim);line-height:1.6',
      text: 'Balances and settlement are simulated inside this application. No wallet is connected and no on-chain transaction is broadcast.'
    }));
  } catch (error) {
    host.innerHTML = `<div class="alert error">${esc(error.message)}</div>`;
  }
}
