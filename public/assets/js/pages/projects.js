import { api, requireSession } from '../api.js';
import { mountShell } from '../shell.js';
import { $, el, esc, money, statusTag, formatDate } from '../ui.js';

const session = await requireSession();

if (session) {
  await mountShell({
    title: session.user.role === 'admin' ? 'All projects' : 'Projects',
    crumb: `Horizon / ${session.user.company || session.user.name} / Projects`,
    actions: session.user.role === 'client'
      ? [el('a', { class: 'btn sm primary', href: '/app/briefs.html?new=1' }, ['+ New brief'])]
      : []
  });
  load();
}

async function load() {
  const host = $('#page');
  host.innerHTML = '<div class="skeleton"></div>';
  try {
    const { projects } = await api.get('/api/projects');
    host.innerHTML = '';
    if (!projects.length) {
      host.append(el('div', { class: 'empty' }, [
        el('strong', { text: 'No project rooms yet' }),
        session.user.role === 'client'
          ? 'Post a brief, invite a specialist, and a project room opens as soon as they accept.'
          : 'Accept an invitation and a project room opens automatically.'
      ]));
      return;
    }

    const grouped = { active: [], in_review: [], completed: [], cancelled: [] };
    for (const project of projects) (grouped[project.status] || grouped.active).push(project);

    for (const [status, label] of [['active', 'Active'], ['in_review', 'In review'], ['completed', 'Completed'], ['cancelled', 'Cancelled']]) {
      const group = grouped[status];
      if (!group.length) continue;
      host.append(el('div', { class: 'section-title' }, [el('h2', { text: `${label} · ${group.length}` })]));
      const grid = el('div', { class: 'grid-2' });
      for (const project of group) grid.append(projectCard(project));
      host.append(grid);
    }
  } catch (error) {
    host.innerHTML = `<div class="alert error">${esc(error.message)}</div>`;
  }
}

function projectCard(project) {
  const counterparty = session.user.role === 'talent' ? project.client : project.talent;
  const nextMilestone = project.milestones.find((milestone) => milestone.status !== 'paid');
  return el('article', { class: 'brief-card' }, [
    el('div', { class: 'head' }, [
      el('div', {}, [
        el('h3', { text: project.name }),
        el('p', { class: 'meta', text: `${counterparty.company || counterparty.name} · opened ${formatDate(project.createdAt)}` })
      ]),
      el('span', { html: statusTag(project.status) })
    ]),
    el('div', {}, [
      el('div', { class: 'progress', style: 'margin-bottom:7px' }, [el('i', { style: `width:${project.totals.progress}%` })]),
      el('p', {
        style: 'margin:0;font:9.5px var(--mono);letter-spacing:.9px;text-transform:uppercase;color:var(--muted-dim)',
        text: `${project.totals.progress}% paid · ${money(project.totals.paid, project.asset)} of ${money(project.totals.total)}`
      })
    ]),
    nextMilestone
      ? el('p', { style: 'margin:0;font-size:12.5px;color:var(--muted)' }, [
        el('strong', { style: 'color:var(--paper)', text: `Next: ${nextMilestone.title}` }),
        ` · ${money(nextMilestone.amount, project.asset)} · `,
        el('span', { html: statusTag(nextMilestone.status) })
      ])
      : el('p', { style: 'margin:0;font-size:12.5px;color:var(--muted)', text: 'All milestones paid.' }),
    el('div', { class: 'foot' }, [
      el('span', {
        style: 'font:9.5px var(--mono);color:var(--muted-dim);text-transform:uppercase;letter-spacing:.9px',
        text: `${project.milestones.length} milestones · ${project.asset} on ${project.network}`
      }),
      el('a', { class: 'btn sm primary', href: `/app/project.html?id=${encodeURIComponent(project.id)}` }, ['Open room →'])
    ])
  ]);
}
