import { api, requireSession, me, clearMeCache } from '../api.js';
import { mountShell } from '../shell.js';
import { $, el, esc, toast, formValues, applyFieldErrors, clearFieldErrors, withBusy, param, statusTag } from '../ui.js';

const ASSETS = ['USDC', 'USDT', 'ETH', 'SOL', 'BTC', 'Fiat'];
const NETWORKS = ['Base', 'Solana', 'Ethereum', 'Arbitrum', 'Polygon', 'Bank'];
const AVAILABILITY = [
  ['available_now', 'Available now'],
  ['two_weeks', 'Within 2 weeks'],
  ['next_month', 'Next month'],
  ['unavailable', 'Not taking work']
];

const session = await requireSession(['talent']);

if (session) {
  await mountShell({
    title: 'My profile',
    crumb: `Horizon / ${session.user.name} / Profile`,
    actions: [el('a', { class: 'btn sm ghost', href: '/app/opportunities.html' }, ['Browse briefs'])]
  });
  render();
}

async function render() {
  const host = $('#page');
  host.innerHTML = '<div class="skeleton" style="min-height:200px"></div>';
  try {
    const [{ profile, walletAddress }, { skills }] = await Promise.all([api.get('/api/profile'), api.get('/api/skills')]);
    host.innerHTML = '';

    if (param('welcome')) {
      host.append(el('div', { class: 'alert info' }, [
        'Welcome to Horizon. Complete this profile and an operator will review it — usually within a working day. Approved profiles appear in the directory and in client shortlists.'
      ]));
    }

    host.append(el('div', { class: 'alert ' + (profile.status === 'approved' ? 'ok' : profile.status === 'rejected' ? 'error' : 'info') }, [
      el('strong', { text: profile.status === 'approved' ? 'Your profile is live. ' : profile.status === 'rejected' ? 'Your profile needs changes. ' : 'Your profile is awaiting review. ' }),
      profile.status === 'approved'
        ? 'You appear in the public directory and in client match results.'
        : profile.status === 'rejected'
          ? 'Update the details below and it returns to the review queue automatically.'
          : 'An operator reviews new profiles before they go live. You can keep editing in the meantime.'
    ]));

    const chosen = new Set(profile.skills);
    const grouped = skills.reduce((map, skill) => {
      (map[skill.category] ||= []).push(skill);
      return map;
    }, {});

    const form = el('form', { id: 'profile-form', novalidate: true });
    form.innerHTML = `
      <div class="two-col">
        <section class="card">
          <div class="card-head"><h2>How you present</h2><span>${statusTag(profile.status)}</span></div>
          <label class="field"><span>Headline</span>
            <input name="headline" required minlength="6" maxlength="120" placeholder="Senior web developer & design engineer">
            <span class="field-hint">One line clients see first in the directory and in shortlists.</span>
          </label>
          <label class="field"><span>About you</span>
            <textarea name="bio" required minlength="40" maxlength="1200" rows="5"
              placeholder="What you build, who you build it for, and what working with you is like."></textarea>
            <span class="field-hint">At least 40 characters.</span>
          </label>
          <div class="grid-2">
            <label class="field"><span>Location</span><input name="location" required maxlength="80" placeholder="London, UK"></label>
            <label class="field"><span>Timezone</span><input name="timezone" maxlength="60" placeholder="Europe/London"></label>
            <label class="field"><span>Portfolio URL</span><input name="portfolio_url" type="url" maxlength="200" placeholder="https://your.work"></label>
            <label class="field"><span>Years of experience</span><input name="years_experience" inputmode="numeric" placeholder="8"></label>
          </div>
          <div class="field">
            <span class="field-label">Your skills</span>
            <div id="skill-groups"></div>
            <span class="field-hint">Pick one to twelve. Skill overlap is the heaviest part of the match score.</span>
            <span class="field-error" id="skills-error"></span>
          </div>
        </section>
        <aside class="card">
          <div class="card-head"><h2>Rate & availability</h2></div>
          <div class="grid-2">
            <label class="field"><span>Rate from ($/hr)</span><input name="rate_min" required inputmode="numeric" placeholder="85"></label>
            <label class="field"><span>Rate to ($/hr)</span><input name="rate_max" required inputmode="numeric" placeholder="120"></label>
          </div>
          <label class="field"><span>Availability</span>
            <select name="availability">${AVAILABILITY.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select>
          </label>
          <label class="field"><span>Weekly capacity (hours)</span><input name="weekly_capacity" inputmode="numeric" placeholder="25"></label>
          <div class="card-head" style="margin-top:20px"><h3>Getting paid</h3></div>
          <div class="grid-2">
            <label class="field"><span>Payout asset</span>
              <select name="payout_asset">${ASSETS.map((asset) => `<option>${asset}</option>`).join('')}</select>
            </label>
            <label class="field"><span>Network</span>
              <select name="payout_network">${NETWORKS.map((network) => `<option>${network}</option>`).join('')}</select>
            </label>
          </div>
          <label class="field"><span>Wallet or account reference</span>
            <input name="wallet_address" maxlength="120" placeholder="0x… or bank reference">
            <span class="field-hint">Stored for display only. Settlement in this build is simulated.</span>
          </label>
          <div class="alert error" id="profile-error" hidden></div>
          <button class="btn primary block" type="submit">Save profile</button>
        </aside>
      </div>`;
    host.append(form);

    const groupHost = $('#skill-groups', form);
    for (const [category, list] of Object.entries(grouped)) {
      groupHost.append(el('p', { class: 'kicker', style: 'margin:12px 0 6px', text: category }));
      groupHost.append(el('div', { class: 'chip-set' }, list.map((skill) => el('button', {
        class: 'chip', type: 'button', 'aria-pressed': String(chosen.has(skill.name)),
        onclick: (event) => {
          if (chosen.has(skill.name)) chosen.delete(skill.name);
          else chosen.add(skill.name);
          event.currentTarget.setAttribute('aria-pressed', String(chosen.has(skill.name)));
        }
      }, [skill.name]))));
    }

    Object.assign(form.elements, {});
    form.elements.headline.value = profile.headline;
    form.elements.bio.value = profile.bio;
    form.elements.location.value = profile.location;
    form.elements.timezone.value = profile.timezone;
    form.elements.portfolio_url.value = profile.portfolioUrl;
    form.elements.years_experience.value = profile.yearsExperience;
    form.elements.rate_min.value = profile.rateMin || '';
    form.elements.rate_max.value = profile.rateMax || '';
    form.elements.availability.value = profile.availability;
    form.elements.weekly_capacity.value = profile.weeklyCapacity;
    form.elements.payout_asset.value = profile.payoutAsset;
    form.elements.payout_network.value = profile.payoutNetwork;
    form.elements.wallet_address.value = walletAddress || '';

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      clearFieldErrors(form);
      const errorBox = $('#profile-error', form);
      errorBox.hidden = true;
      $('#skills-error', form).textContent = '';
      if (!chosen.size) {
        $('#skills-error', form).textContent = 'Choose at least one skill.';
        return;
      }
      const submit = form.querySelector('button[type="submit"]');
      try {
        await withBusy(submit, () => api.put('/api/profile', { ...formValues(form), skills: [...chosen] }));
        clearMeCache();
        await me(true);
        toast('Profile saved.', { title: 'Saved' });
        render();
      } catch (error) {
        applyFieldErrors(form, error.details);
        errorBox.textContent = error.message;
        errorBox.hidden = false;
      }
    });
  } catch (error) {
    host.innerHTML = `<div class="alert error">${esc(error.message)}</div>`;
  }
}
