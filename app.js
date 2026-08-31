(() => {
  const endpointByForm = {
    'interest-form': '/api/applications',
    'application': '/api/applications',
    'brief': '/api/briefs'
  };

  function valuesFor(form) {
    return [...form.querySelectorAll('input, select, textarea')].reduce((values, field) => {
      if (field.type === 'button' || field.type === 'submit') return values;
      const key = field.name || field.id || field.getAttribute('aria-label') || field.placeholder || field.closest('label')?.textContent?.trim() || 'field';
      values[key] = field.value;
      return values;
    }, {});
  }

  Object.entries(endpointByForm).forEach(([id, endpoint]) => {
    const form = document.getElementById(id);
    if (!form) return;
    form.addEventListener('submit', () => {
      fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: id, values: valuesFor(form) }) }).catch(() => {});
    }, true);
  });

  const release = document.getElementById('release');
  if (release) release.addEventListener('click', () => {
    fetch('/api/payments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'pending_confirmation', amount: '1700', asset: 'USDC', network: 'Base' }) }).catch(() => {});
  });
})();
