import { me } from './api.js';
import { mountTalentSearch } from './talent-search.js';
import { $, param } from './ui.js';

const CATEGORY_SKILLS = {
  'Web development': ['Next.js', 'React', 'Webflow', 'Shopify', 'Node.js', 'Three.js'],
  'App development': ['React Native', 'Swift', 'Flutter', 'Kotlin'],
  'AI automation': ['LLM integration', 'Workflow automation', 'Data pipelines', 'Prompt engineering'],
  'Creative production': ['Video editing', 'Motion design', 'Thumbnail design', 'Short-form clipping', 'Script writing', 'Brand identity'],
  Web3: ['Smart contracts', 'Solidity', 'Tokenomics', 'DeFi integration']
};

me().then((session) => {
  if (!session.user) return;
  const cta = $('#nav-cta');
  cta.textContent = 'Open workspace ↗';
  cta.href = '/app/dashboard.html';
}).catch(() => { /* directory is public */ });

// A category link from the landing page pre-seeds that discipline's search term.
const category = param('category');
mountTalentSearch($('#results'), {
  initial: {
    q: param('q'),
    availability: param('availability'),
    skill: param('skill') ? [param('skill')] : [],
    sort: category ? 'rating' : 'relevance'
  }
});

if (category && CATEGORY_SKILLS[category]) {
  document.title = `Horizon — ${category} specialists`;
  const heading = document.querySelector('h1');
  heading.innerHTML = `${category} <em>specialists.</em>`;
}
